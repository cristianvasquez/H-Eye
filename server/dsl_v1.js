const serverOptions = require("../config").serverOptions;
const schemas = require("../config").schemas;
const fu = require("./persistence");
const _ = require('lodash');
const validUrl = require('valid-url');
const path = require('path');
const Ajv = require('ajv');
const Glob = require("glob").Glob

// https://github.com/jriecken/dependency-graph
const DepGraph = require('dependency-graph').DepGraph;

function toJson(x) {
    return JSON.stringify(x, null, 2);
}

let ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
let metaOperationSchema = fu.readJson(schemas.metaOperationSchema);
let crudOperationsSchema = fu.readJson(schemas.crudOperationsSchema);
let hEyeSchema = fu.readJson(schemas.hEyeSchema);

let validateOperation = ajv.compile(metaOperationSchema);
let validateCrudOperation = ajv.compile(crudOperationsSchema);
let validateDeclaration = ajv.compile(hEyeSchema);


class DSL_V1 {

    constructor(context) {
        this.context = context;
    }

    static validateOperation(meta) {
        let valid = validateOperation(meta);
        if (!valid) console.error(validateOperation.errors);
        return valid;
    }

    static validateCrudOperation(meta) {
        let valid = validateCrudOperation(meta);
        if (!valid) console.error(validateCrudOperation.errors);
        return valid;
    }

    static validateDeclaration(meta) {
        let valid = validateDeclaration(meta);
        if (!valid) console.error(validateDeclaration.errors);
        return valid;
    }

    /**
     * Experimental, dependency graph
     *
     * TODO Refactor
     */
    buildLocalDependencyGraph(dirRelativeTo){

        let graph = new DepGraph({ circular: false });

        // All files
        let pattern = "**/"+serverOptions.indexFile;
        let indexes = new Glob(pattern, {mark: true, sync:true, absolute:true, nodir:true, cwd:dirRelativeTo}).found;

        for (let currentDir of indexes){
            let index = fu.readJson(currentDir);
            if (index.meta){
                for (let meta of index.meta) {
                    let parent = currentDir.substr(0, currentDir.lastIndexOf('/'));
                    let id = (parent.replaceAll(serverOptions.workSpacePath, '') + '/' + meta.name);
                    graph.addNode(id, meta );
                }
            }
        }

        for (let currentDir of indexes){
            let index = fu.readJson(currentDir);
            if (index.meta){
                for (let meta of index.meta) {
                    addDependencies(currentDir,meta);
                }
            }
        }

        function addHref(dirRelativeTo,from,to){
            if (!validUrl.is_web_uri(to)) {
                let dependency = DSL_V1.toAbsolutePath(dirRelativeTo,to);
                let operation = DSL_V1.findOperation(dependency);
                if (operation.exists) {
                    graph.addDependency(from, dependency.replaceAll(serverOptions.workSpacePath,''));
                }
            }
        }

        function addInferenceDependencies(dirRelativeTo,from,inference,field){
            if (inference[field]){
                if (inference[field].href) {
                    let href = inference[field].href;
                    // One value
                    if (typeof href === 'string') {
                        addHref(dirRelativeTo,from,href);
                    } else {
                        // Array of values
                        inference[field].href = _.flatMap(href, href => {
                            addHref(dirRelativeTo,from,href);
                        });
                    }
                }
            }
        }

        function addDependencies(dirRelativeTo,meta){
            let parent = dirRelativeTo.substr(0, dirRelativeTo.lastIndexOf('/'));
            let from = (parent.replaceAll(serverOptions.workSpacePath,'')+'/'+meta.name);

            if (meta.query || meta['raw']) {
                // No dependencies
            } else if (meta.href) {
                addHref(dirRelativeTo,from,meta.href);
            } else if (meta.inference) {
                let inference = meta.inference;

                // Query dependencies
                if (inference.query.href) {
                    addHref(dirRelativeTo,from,inference.query.href);
                }
                // Data dependencies
                addInferenceDependencies(dirRelativeTo,from,inference,'data')
            } else if (meta.imports) {
                let imports = meta.imports;

                addHref(dirRelativeTo,from,imports.href);

                // Query dependencies
                if (imports.query){
                    if (imports.query.href) {
                        addHref(dirRelativeTo,from,imports.query.href);
                    }
                }
                addInferenceDependencies(dirRelativeTo,from,imports,'data');
                addInferenceDependencies(dirRelativeTo,from,imports,'addData');
            }
        }

        for (let operation of graph.overallOrder()){
            let nodeData = graph.getNodeData(operation);
            let operationDir = DSL_V1.toAbsolutePath(serverOptions.workSpacePath,operation);
            operationDir = operationDir.substr(0, operationDir.lastIndexOf('/'));
            graph.setNodeData(operation, this.expandMeta(operationDir,   nodeData));
        }

        return graph;
    }

    /**
     * First layer
     *
     * Expand relative files
     * Expand directories
     */

    expandMeta(dirRelativeTo, meta) {
        let valid = validateDeclaration(meta);
        if (!valid) {
            throw Error(JSON.stringify(validateDeclaration.errors,null,2));
        }

        if (meta.query || meta['raw']) {
            return meta;
        } else if (meta.href) {
            return this.expandHref(dirRelativeTo, meta);
        } else if (meta.inference) {
            return this.expandInference(dirRelativeTo, meta);
        } else if (meta.imports) {
            return this.expandImports(dirRelativeTo, meta);
        }
        throw Error("I don't know how to interpret:" + toJson(meta));
    }

    expandHref(dirRelativeTo, meta) {
        meta.href = this.toDereferenciable(dirRelativeTo, meta.href);
        return meta;
    }

    expandInference(dirRelativeTo, meta) {
        let inference = meta.inference;

        // Expand query
        if (inference.query.href) {
            inference.query.href = this.toDereferenciable(dirRelativeTo, inference.query.href);
        }

        if (inference.data.href) {
            let href = inference.data.href;
            // One value
            if (typeof href === 'string') {
                inference.data.href = this.toDereferenciables(dirRelativeTo, href);
            } else {
                // Array of values
                inference.data.href = _.flatMap(href, href => {
                    return this.toDereferenciables(dirRelativeTo, href);
                });
            }

        }
        meta.inference = inference;
        return meta;
    }

    expandImports(dirRelativeTo, meta) {

        let targetDir = DSL_V1.toAbsolutePath(dirRelativeTo, meta.imports.href);
        let _operation = DSL_V1.findOperation(targetDir);

        if (_operation.exists) {
            targetDir = targetDir.substr(0, targetDir.lastIndexOf('/'));

            // Override meta if present
            if (meta['Content-Type']){
                _operation.operation['Content-Type'] = meta['Content-Type'];
            }

            if (_operation.operation.inference) {

                // This expansion is to keep the absolute paths of the extended.
                let operation = this.expandInference(targetDir, _operation.operation);

                /**
                 * It's not clear yet how I will represent Set, Union, Intersection etc.
                 */
                meta.inference = {};

                function overrideIfExisting(current) {
                    // If parameter is defined in the extends clause, it overrides the one of the extended one.
                    if (meta.imports[current]) {
                        meta.inference[current] = meta.imports[current];
                    } else {
                        if (operation.inference[current]) {
                            meta.inference[current] = operation.inference[current];
                        }
                    }
                }

                overrideIfExisting('query');
                overrideIfExisting('options');
                overrideIfExisting('flags');

                // Special case, addData (adds data to the current extended)
                if (meta.imports['addData']) {
                    let data = [];
                    if (operation.inference.data) {
                        data = operation.inference.data.href;
                    }
                    let href = meta.imports['addData'].href;
                    // make sure is an array
                    if (typeof href === 'string') {
                        href = [href]
                    }
                    // Add them if they are not there
                    for (let current of href) {
                        if (data.indexOf(current) < 0) {
                            data.push(current);
                        }
                    }
                    meta.inference.data = {
                        'href': data
                    };
                } else {
                    overrideIfExisting('data');
                }

                delete meta.imports;
                return this.expandInference(dirRelativeTo, meta);
            }

            // It was other kind of operation
            return this.expandMeta(targetDir, _operation.operation);
        } else {
            throw new Error('Could not find operation  ' + meta.imports.href + ' in ' + targetDir);
        }
    }

    static findOperation(target) {
        let targetDir = target.substr(0, target.lastIndexOf('/'));
        let name = target.substr(target.lastIndexOf('/') + 1);

        // Gets the template
        if (fu.exists(targetDir + '/' + serverOptions.indexFile)) {
            let index = fu.readJson(targetDir + '/' + serverOptions.indexFile);
            if (index.meta) {
                for (let operation of index.meta) {
                    if (operation.name === name) {
                        return {
                            exists: true,
                            operation: operation
                        }
                    }
                }
            }
        }
        return {
            exists: false
        }
    }

    /**
     * Goes from relative path to absolute path
     * Fails if not in the current workspace
     */
    static toAbsolutePath(dirRelativeTo, value) {

        if (typeof value !== 'string') {
            throw Error("I don't know how to handle " + toJson(value));
        }

        // Already expanded
        if (value.startsWith(serverOptions.workSpacePath)) {
            return value;
        }

        let result;
        if (path.isAbsolute(value)) {
            result = path.join(serverOptions.workSpacePath, value);
        } else {
            result = path.join(dirRelativeTo, value);
        }

        if (!result.startsWith(serverOptions.workSpacePath)) {
            throw Error('403 [' + result + ']');
        }

        return result;

    }


    /**
     * Expands an href into a de-referenciable resource (by the reasoner)
     *
     * Valid href values are:
     *
     *  - An external URL, which expands to URL.
     *  - A file (relative), which expands to a file.
     *  - A file (absolute), which expands to a file.
     *  - A call to a meta-operation, which expands to URL.
     */
    toDereferenciable(dirRelativeTo, value) {
        // External URL
        if (validUrl.is_web_uri(value)) { // other uri resources
            return value;
        }

        // If its already expanded
        let targetPath = DSL_V1.toAbsolutePath(dirRelativeTo, value);

        if (!fu.exists(targetPath)){
            let operation = DSL_V1.findOperation(targetPath);
            if (operation.exists) {
                if (this.context){
                    return this.context.toApiPath(targetPath);
                } else {
                    return targetPath.replaceAll(serverOptions.workSpacePath,'');
                }
            }
            throw Error('404 [' + value + ']');
        } else {
            return targetPath;
        }
    }

    /**
     * Expands an href into a list of de-referenciable resources (by the reasoner)
     *
     * Valid href values are:
     *
     *  - An external URL, which expands to [URL].
     *  - A directory (relative), which expands to an array of files.
     *  - A directory (absolute), which expands to an array of files.
     *  - A file (relative), which expands to a [file].
     *  - A file (absolute), which expands to a [file].
     *  - A call to a meta-operation, which expands to an URL
     */

    // Found the glorious node-glob implementation.

    toDereferenciables(dirRelativeTo, value) {
        // External URL
        if (validUrl.is_web_uri(value)) { // other uri resources
            return [value]
        }

        let glob;
        if (path.isAbsolute(value)) {
            // options for absolute
            let options = {mark: true, sync:true, root:serverOptions.workSpacePath, ignore:'**/'+serverOptions.indexFile, absolute:false, nodir:true};
            glob = new Glob(value.replaceAll(serverOptions.workSpacePath,''), options);
        } else {
            // options for relative
            let options = {mark: true, sync:true, cwd:dirRelativeTo, ignore:'**/'+serverOptions.indexFile, absolute:true, nodir:true};
            glob = new Glob(value, options);
        }


        if (glob.found && glob.found.length > 0){
            return glob.found;
        }

        let targetPath = DSL_V1.toAbsolutePath(dirRelativeTo, value);
        let operation = DSL_V1.findOperation(targetPath);
        if (operation.exists) {
            if (this.context){
                return [this.context.toApiPath(targetPath)];
            } else {
                return [targetPath.replaceAll(serverOptions.workSpacePath,'')];
            }
        }

        if (!fu.exists(targetPath)){
            throw Error('404 [' + targetPath + ']');
        }

        if (fu.isDirectory(targetPath)){
            throw Error('400 [' + targetPath + '] is directory');
        }

        throw Error('500 [' + targetPath + ' unhandled error ]');
    }

}

module.exports = DSL_V1;