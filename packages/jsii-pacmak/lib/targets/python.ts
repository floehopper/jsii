import path = require('path');
import util = require('util');

import { CodeMaker, toSnakeCase } from 'codemaker';
import * as escapeStringRegexp from 'escape-string-regexp';
import * as spec from 'jsii-spec';
import { Generator, GeneratorOptions } from '../generator';
import { Target, TargetOptions } from '../target';
import { shell } from '../util';

export default class Python extends Target {
    protected readonly generator = new PythonGenerator();

    constructor(options: TargetOptions) {
        super(options);
    }

    public async build(sourceDir: string, outDir: string): Promise<void> {
        // Format our code to make it easier to read, we do this here instead of trying
        // to do it in the code generation phase, because attempting to mix style and
        // function makes the code generation harder to maintain and read, while doing
        // this here is easy.
        await shell("black", ["--py36", sourceDir], {});

        // Actually package up our code, both as a sdist and a wheel for publishing.
        await shell("python", ["setup.py", "sdist", "--dist-dir", outDir], { cwd: sourceDir });
        await shell("python", ["setup.py", "bdist_wheel", "--dist-dir", outDir], { cwd: sourceDir });
    }
}

// ##################
// # CODE GENERATOR #
// ##################
const debug = (o: any) => {
    // tslint:disable-next-line:no-console
    console.log(util.inspect(o, false, null, true));
};

const PYTHON_BUILTIN_TYPES = ["bool", "str", "None"];

const PYTHON_KEYWORDS = [
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
    "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
    "raise", "return", "try", "while", "with", "yield"
];

const toPythonModuleName = (name: string): string => {
    if (name.match(/^@[^/]+\/[^/]+$/)) {
        name = name.replace(/^@/g, "");
        name = name.replace(/\//g, ".");
    }

    name = toSnakeCase(name.replace(/-/g, "_"));

    return name;
};

const toPythonModuleFilename = (name: string): string => {
    if (name.match(/^@[^/]+\/[^/]+$/)) {
        name = name.replace(/^@/g, "");
        name = name.replace(/\//g, ".");
    }

    name = name.replace(/\./g, "/");

    return name;
};

const toPythonPackageName = (name: string): string => {
    return toPythonModuleName(name).replace(/_/g, "-");
};

const toPythonIdentifier = (name: string): string => {
    if (PYTHON_KEYWORDS.indexOf(name) > -1) {
        return name + "_";
    }

    return name;
};

const toPythonMethodName = (name: string): string => {
    return toPythonIdentifier(toSnakeCase(name));
};

const toPythonPropertyName = (name: string): string => {
    return toPythonIdentifier(toSnakeCase(name));
};

const toPythonType = (typeref: spec.TypeReference, respectOptional: boolean = true): string => {
    let pythonType: string;

    // Get the underlying python type.
    if (spec.isPrimitiveTypeReference(typeref)) {
        pythonType = toPythonPrimitive(typeref.primitive);
    } else if (spec.isCollectionTypeReference(typeref)) {
        pythonType = toPythonCollection(typeref);
    } else if (spec.isNamedTypeReference(typeref)) {
        pythonType = toPythonFQN(typeref.fqn);
    } else if (typeref.union) {
        const types = new Array<string>();
        for (const subtype of typeref.union.types) {
            types.push(toPythonType(subtype));
        }
        pythonType = `typing.Union[${types.join(", ")}]`;
    } else {
        throw new Error("Invalid type reference: " + JSON.stringify(typeref));
    }

    // If our type is Optional, then we'll wrap our underlying type with typing.Optional
    // However, if we're not respecting optionals, then we'll just skip over this.
    if (respectOptional && typeref.optional) {
        pythonType = `typing.Optional[${pythonType}]`;
    }

    return pythonType;
};

const toPythonCollection = (ref: spec.CollectionTypeReference) => {
    const elementPythonType = toPythonType(ref.collection.elementtype);
    switch (ref.collection.kind) {
        case spec.CollectionKind.Array: return `typing.List[${elementPythonType}]`;
        case spec.CollectionKind.Map: return `typing.Mapping[str,${elementPythonType}]`;
        default:
            throw new Error(`Unsupported collection kind: ${ref.collection.kind}`);
    }
};

const toPythonPrimitive = (primitive: spec.PrimitiveType): string => {
    switch (primitive) {
        case spec.PrimitiveType.Boolean: return "bool";
        case spec.PrimitiveType.Date: return "datetime.datetime";
        case spec.PrimitiveType.Json: return "typing.Mapping[typing.Any, typing.Any]";
        case spec.PrimitiveType.Number: return "jsii.Number";
        case spec.PrimitiveType.String: return "str";
        case spec.PrimitiveType.Any: return "typing.Any";
        default:
            throw new Error("Unknown primitive type: " + primitive);
    }
};

const toPythonFQN = (name: string): string => {
    const [, modulePart, typePart] = name.match(/^((?:[^A-Z\.][^\.]+\.?)+)\.([A-Z].+)$/) as string[];
    const fqnParts = [
        toPythonModuleName(modulePart),
        typePart.split(".").map(cur => toPythonIdentifier(cur)).join(".")
    ];

    return fqnParts.join(".");
};

const formatPythonType = (type: string, forwardReference: boolean = false, moduleName: string) => {
    // If we split our types by any of the "special" characters that can't appear in
    // identifiers (like "[],") then we will get a list of all of the identifiers,
    // no matter how nested they are. The downside is we might get trailing/leading
    // spaces or empty items so we'll need to trim and filter this list.
    const types = type.split(/[\[\],]/).map((s: string) => s.trim()).filter(s => s !== "");
    // const moduleRe = new RegExp(`^${escapeStringRegexp(moduleName)}\.([A-Z].+)$`);

    for (const innerType of types) {
        // Built in types do not need formatted in any particular way.
        if (PYTHON_BUILTIN_TYPES.indexOf(innerType) > -1) {
            continue;
        }

        // If we do not have a current moduleName, or the type is not within that
        // module, then we don't format it any particular way.
        // if (!moduleRe.test(innerType)) {
        if (!innerType.startsWith(moduleName + ".")) {
            continue;
        } else {
            const typeName = innerType.substring(moduleName.length + 1, innerType.length);
            // const [, typeName] = innerType.match(moduleRe) as string[];
            const re = new RegExp('((?:^|[[,\\s])"?)' + innerType + '("?(?:$|[\\],\\s]))');

            // If this is our current module, then we need to correctly handle our
            // forward references, by placing the type inside of quotes, unless
            // we're returning real forward references.
            if (!forwardReference && !typeName.match(/^[a-z]/)) {
                type = type.replace(re, `$1"${innerType}"$2`);
            }

            // Now that we've handled (or not) our forward references, then we want
            // to replace the module with just the type name.
            // type = type.replace(re, "$1" + innerType.substring(moduleName.length + 1, innerType.length) + "$2");
            type = type.replace(re, `$1${typeName}$2`);
        }
    }

    return type;
};

const setDifference = (setA: Set<any>, setB: Set<any>): Set<any> => {
    const difference = new Set(setA);
    for (const elem of setB) {
        difference.delete(elem);
    }
    return difference;
};

const sortMembers = (sortable: PythonCollectionNode[]): PythonCollectionNode[] => {
    const sorted: PythonCollectionNode[] = [];
    const sortedFQNs: Set<string> = new Set();

    // We're going to take a copy of our sortable item, because it'll make it easier if
    // this method doesn't have side effects.
    sortable = sortable.slice();

    while (sortable.length > 0) {
        let idx: number | undefined;

        for (const [idx2, item] of sortable.entries()) {
            if (setDifference(new Set(item.depends_on), sortedFQNs).size === 0) {
                sorted.push(item);
                sortedFQNs.add(item.fqn);
                idx = idx2;
                break;
            } else {
                idx = undefined;
            }
        }

        if (idx === undefined) {
            throw new Error("Could not sort members.");
        } else {
            sortable.splice(idx, 1);
        }
    }

    return sorted;
};

const isInModule = (modName: string, fqn: string): boolean => {
    return new RegExp(`^${escapeStringRegexp(modName)}\.[^\.]+$`).test(fqn);
};

interface PythonNode {

    // The name of the module that this Node exists in.
    readonly moduleName: string;

    // The name of the given Node.
    readonly name: string;

    // The fully qualifed name of this node.
    readonly fqn: string;

    // Emits the entire tree of objects represented by this object into the given
    // CodeMaker object.
    emit(code: CodeMaker): void;
}

interface PythonCollectionNode extends PythonNode {
    // A list of other nodes that this node depends on, can be used to sort a list of
    // nodes so that nodes get emited *after* the nodes it depends on.
    readonly depends_on: string[];

    // Given a particular item, add it as a member of this collection of nodes, returns
    // the original member back.
    addMember(member: PythonNode): PythonNode;
}

class BaseMethod implements PythonNode {

    public readonly moduleName: string;
    public readonly parent: PythonCollectionNode;
    public readonly name: string;

    protected readonly decorator?: string;
    protected readonly implicitParameter: string;
    protected readonly jsiiMethod?: string;
    protected readonly classAsFirstParameter: boolean = false;
    protected readonly returnFromJSIIMethod: boolean = true;

    private readonly jsName?: string;
    private readonly parameters: spec.Parameter[];
    private readonly returns?: spec.TypeReference;
    private readonly liftedProp?: spec.InterfaceType;

    constructor(moduleName: string,
                parent: PythonCollectionNode,
                name: string,
                jsName: string | undefined,
                parameters: spec.Parameter[],
                returns?: spec.TypeReference,
                liftedProp?: spec.InterfaceType) {
        this.moduleName = moduleName;
        this.parent = parent;
        this.name = name;
        this.jsName = jsName;
        this.parameters = parameters;
        this.returns = returns;
        this.liftedProp = liftedProp;
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    public emit(code: CodeMaker) {
        const returnType = this.getReturnType(this.returns);

        // We need to turn a list of JSII parameters, into Python style arguments with
        // gradual typing, so we'll have to iterate over the list of parameters, and
        // build the list, converting as we go.
        // TODO: Handle imports (if needed) for all of these types.
        const pythonParams: string[] = [this.implicitParameter];
        for (const param of this.parameters) {
            const paramName = toPythonIdentifier(param.name);
            const paramType = toPythonType(param.type);

            pythonParams.push(`${paramName}: ${formatPythonType(paramType, false, this.moduleName)}`);
        }

        // If we have a lifted parameter, then we'll drop the last argument to our params
        // and then we'll lift all of the params of the lifted type as keyword arguments
        // to the function.
        if (this.liftedProp !== undefined) {
            // Remove our last item.
            pythonParams.pop();

            if (this.liftedProp.properties !== undefined && this.liftedProp.properties.length >= 1) {
                // All of these parameters are keyword only arguments, so we'll mark them
                // as such.
                pythonParams.push("*");

                // Iterate over all of our props, and reflect them into our params.
                for (const prop of this.liftedProp.properties) {
                    const paramName = toPythonIdentifier(prop.name);
                    const paramType = toPythonType(prop.type);
                    const paramDefault = prop.type.optional ? "=None" : "";

                    pythonParams.push(`${paramName}: ${formatPythonType(paramType, false, this.moduleName)}${paramDefault}`);
                }
            }
        } else if (this.parameters.length >= 1 && this.parameters.slice(-1)[0].variadic) {
            // Another situation we could be in, is that instead of having a plain parameter
            // we have a variadic parameter where we need to expand the last parameter as a
            // *args.
            pythonParams.pop();

            const lastParameter = this.parameters.slice(-1)[0];
            const paramName = toPythonIdentifier(lastParameter.name);
            const paramType = toPythonType(lastParameter.type, false);

            pythonParams.push(`*${paramName}: ${formatPythonType(paramType, false, this.moduleName)}`);
        }

        if (this.decorator !== undefined) {
            code.line(`@${this.decorator}`);
        }

        code.openBlock(`def ${this.name}(${pythonParams.join(", ")}) -> ${formatPythonType(returnType, false, this.moduleName)}`);
        this.emitBody(code);
        code.closeBlock();
    }

    private emitBody(code: CodeMaker) {
        if (this.jsiiMethod === undefined) {
            code.line("...");
        } else {
            if (this.liftedProp !== undefined) {
                this.emitAutoProps(code);
            }

            this.emitJsiiMethodCall(code);
        }
    }

    private emitAutoProps(code: CodeMaker) {
        const lastParameter = this.parameters.slice(-1)[0];
        const argName: string = toPythonIdentifier(lastParameter.name);
        const typeName: string = formatPythonType(toPythonType(lastParameter.type), true, this.moduleName);

        // We need to build up a list of properties, which are mandatory, these are the
        // ones we will specifiy to start with in our dictionary literal.
        const mandatoryPropMembers: string[] = [];
        for (const prop of this.liftedProp!.properties || []) {
            if (prop.type.optional) {
                continue;
            }

            mandatoryPropMembers.push(`"${toPythonIdentifier(prop.name)}": ${toPythonIdentifier(prop.name)}`);
        }
        code.line(`${argName}: ${typeName} = {${mandatoryPropMembers.join(", ")}}`);
        code.line();

        // Now we'll go through our optional properties, and if they haven't been set
        // we'll add them to our dictionary.
        for (const prop of this.liftedProp!.properties || []) {
            if (!prop.type.optional) {
                continue;
            }

            code.openBlock(`if ${toPythonIdentifier(prop.name)} is not None`);
            code.line(`${argName}["${toPythonIdentifier(prop.name)}"] = ${toPythonIdentifier(prop.name)}`);
            code.closeBlock();
        }
    }

    private emitJsiiMethodCall(code: CodeMaker) {
        const methodPrefix: string = this.returnFromJSIIMethod ? "return " : "";

        const jsiiMethodParams: string[] = [];
        if (this.classAsFirstParameter) {
            jsiiMethodParams.push(this.parent.name);
        }
        jsiiMethodParams.push(this.implicitParameter);
        if (this.jsName !== undefined) {
            jsiiMethodParams.push(`"${this.jsName}"`);
        }

        const paramNames: string[] = [];
        for (const param of this.parameters) {
            paramNames.push(toPythonIdentifier(param.name));
        }

        code.line(`${methodPrefix}jsii.${this.jsiiMethod}(${jsiiMethodParams.join(", ")}, [${paramNames.join(", ")}])`);
    }

    private getReturnType(type?: spec.TypeReference): string {
        return type ? toPythonType(type) : "None";
    }
}

class BaseProperty implements PythonNode {

    public readonly moduleName: string;
    public readonly name: string;

    protected readonly decorator: string;
    protected readonly implicitParameter: string;
    protected readonly jsiiGetMethod?: string;
    protected readonly jsiiSetMethod?: string;

    protected readonly jsName: string;
    private readonly type: spec.TypeReference;
    private readonly immutable: boolean;

    constructor(moduleName: string, name: string, jsName: string, type: spec.TypeReference, immutable: boolean) {
        this.moduleName = moduleName;
        this.name = name;
        this.jsName = jsName;
        this.type = type;
        this.immutable = immutable;
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    public emit(code: CodeMaker) {
        const returnType = toPythonType(this.type);

        code.line(`@${this.decorator}`);
        code.openBlock(`def ${this.name}(${this.implicitParameter}) -> ${formatPythonType(returnType, false, this.moduleName)}`);
        this.emitGetterBody(code);
        code.closeBlock();

        if (!this.immutable) {
            code.line(`@${this.name}.setter`);
            code.openBlock(`def ${this.name}(${this.implicitParameter}, value: ${formatPythonType(returnType, false, this.moduleName)})`);
            this.emitSetterBody(code);
            code.closeBlock();
        }
    }

    private emitGetterBody(code: CodeMaker) {
        if (this.jsiiGetMethod === undefined) {
            code.line("...");
        } else {
            code.line(`return jsii.${this.jsiiGetMethod}(${this.implicitParameter}, "${this.jsName}")`);
        }
    }

    private emitSetterBody(code: CodeMaker) {
        if (this.jsiiSetMethod === undefined) {
            code.line("...");
        } else {
            code.line(`return jsii.${this.jsiiSetMethod}(${this.implicitParameter}, "${this.jsName}", value)`);
        }
    }
}

class InterfaceMethod extends BaseMethod {
    protected readonly implicitParameter: string = "self";
}

class InterfaceProperty extends BaseProperty {
    protected readonly decorator: string = "property";
    protected readonly implicitParameter: string = "self";
}

class Interface implements PythonCollectionNode {

    public readonly moduleName: string;
    public readonly name: string;

    private bases: string[];
    private members: PythonNode[];

    constructor(moduleName: string, name: string, bases: string[]) {
        this.moduleName = moduleName;
        this.name = name;
        this.bases = bases;

        this.members = [];
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    get depends_on(): string[] {
        return this.bases.filter(base => isInModule(this.moduleName, base));
    }

    public addMember(member: PythonNode): PythonNode {
        this.members.push(member);
        return member;
    }

    public emit(code: CodeMaker) {
        const interfaceBases = this.bases.map(baseType => formatPythonType(baseType, true, this.moduleName));
        interfaceBases.push("_Protocol");

        code.openBlock(`class ${this.name}(${interfaceBases.join(",")})`);
        if (this.members.length > 0) {
            for (const member of this.members) {
                member.emit(code);
            }
        } else {
            code.line("pass");
        }
        code.closeBlock();
    }
}

class TypedDictProperty implements PythonNode {

    public readonly moduleName: string;
    public readonly name: string;

    private readonly type: spec.TypeReference;

    constructor(moduleName: string, name: string, type: spec.TypeReference) {
        this.moduleName = moduleName;
        this.name = name;
        this.type = type;
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    get optional(): boolean {
        return this.type.optional || false;
    }

    public emit(code: CodeMaker) {
        const propType: string = formatPythonType(toPythonType(this.type, false), undefined, this.moduleName);
        code.line(`${this.name}: ${propType}`);
    }
}

class TypedDict implements PythonCollectionNode {
    public readonly moduleName: string;
    public readonly name: string;

    private members: TypedDictProperty[];

    constructor(moduleName: string, name: string) {
        this.moduleName = moduleName;
        this.name = name;

        this.members = [];
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    get depends_on(): string[] {
        return [];
    }

    public addMember(member: TypedDictProperty): TypedDictProperty {
        this.members.push(member);
        return member;
    }

    public emit(code: CodeMaker) {
        // MyPy doesn't let us mark some keys as optional, and some keys as mandatory,
        // we can either mark either the entire class as mandatory or the entire class
        // as optional. However, we can make two classes, one with all mandatory keys
        // and one with all optional keys in order to emulate this. So we'll go ahead
        // and implement this "split" class logic.

        const mandatoryMembers = this.members.filter(item => !item.optional);
        const optionalMembers = this.members.filter(item => item.optional);

        if (mandatoryMembers.length >= 1 && optionalMembers.length >= 1) {
            // In this case, we have both mandatory *and* optional members, so we'll
            // do our split class logic.

            // We'll emit the optional members first, just because it's a little nicer
            // for the final class in the chain to have the mandatory members.
            code.openBlock(`class _${this.name}(_TypedDict, total=False)`);
            for (const member of optionalMembers) {
                member.emit(code);
            }
            code.closeBlock();

            // Now we'll emit the mandatory members.
            code.openBlock(`class ${this.name}(_${this.name})`);
            for (const member of mandatoryMembers) {
                member.emit(code);
            }
            code.closeBlock();
        } else {
            // In this case we either have no members, or we have all of one type, so
            // we'll see if we have any optional members, if we don't then we'll use
            // total=True instead of total=False for the class.
            if (optionalMembers.length >= 1) {
                code.openBlock(`class ${this.name}(_TypedDict, total=False)`);
            } else {
                code.openBlock(`class ${this.name}(_TypedDict)`);
            }

            // Finally we'll just iterate over and emit all of our members.
            if (this.members.length > 0) {
                for (const member of this.members) {
                    member.emit(code);
                }
            } else {
                code.line("pass");
            }

            code.closeBlock();
        }
    }
}

class StaticMethod extends BaseMethod {
    protected readonly decorator?: string = "classmethod";
    protected readonly implicitParameter: string = "cls";
    protected readonly jsiiMethod: string = "sinvoke";
}

class Initializer extends BaseMethod {
    protected readonly implicitParameter: string = "self";
    protected readonly jsiiMethod: string = "create";
    protected readonly classAsFirstParameter: boolean = true;
    protected readonly returnFromJSIIMethod: boolean = false;
}

class Method extends BaseMethod {
    protected readonly implicitParameter: string = "self";
    protected readonly jsiiMethod: string = "invoke";
}

class StaticProperty extends BaseProperty {
    protected readonly decorator: string = "classproperty";
    protected readonly implicitParameter: string = "cls";
    protected readonly jsiiGetMethod: string = "sget";
    protected readonly jsiiSetMethod: string = "sset";
}

class Property extends BaseProperty {
    protected readonly decorator: string = "property";
    protected readonly implicitParameter: string = "self";
    protected readonly jsiiGetMethod: string = "get";
    protected readonly jsiiSetMethod: string = "set";
}

class Class implements PythonCollectionNode {
    public readonly moduleName: string;
    public readonly name: string;

    private jsiiFQN: string;
    private bases: string[];
    private members: PythonNode[];

    constructor(moduleName: string, name: string, jsiiFQN: string, bases: string[]) {
        this.moduleName = moduleName;
        this.name = name;

        this.jsiiFQN = jsiiFQN;
        this.bases = bases;
        this.members = [];
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    get depends_on(): string[] {
        return this.bases.filter(base => isInModule(this.moduleName, base));
    }

    public addMember(member: PythonNode): PythonNode {
        this.members.push(member);
        return member;
    }

    public emit(code: CodeMaker) {
        const classParams: string[] = this.bases.map(baseType => formatPythonType(baseType, true, this.moduleName));

        classParams.push("metaclass=jsii.JSIIMeta");
        classParams.push(`jsii_type="${this.jsiiFQN}"`);

        code.openBlock(`class ${this.name}(${classParams.join(", ")})`);
        if (this.members.length > 0) {
            for (const member of this.members) {
                member.emit(code);
            }
        } else {
            code.line("pass");
        }
        code.closeBlock();
    }
}

class Enum implements PythonCollectionNode {
    public readonly moduleName: string;
    public readonly name: string;

    private members: PythonNode[];

    constructor(moduleName: string, name: string) {
        this.moduleName = moduleName;
        this.name = name;
        this.members = [];
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    get depends_on(): string[] {
        return [];
    }

    public addMember(member: PythonNode): PythonNode {
        this.members.push(member);
        return member;
    }

    public emit(code: CodeMaker) {
        code.openBlock(`class ${this.name}(enum.Enum)`);
        if (this.members.length > 0) {
            for (const member of this.members) {
                member.emit(code);
            }
        } else {
            code.line("pass");
        }
        code.closeBlock();
    }
}

class EnumMember implements PythonNode {
    public readonly moduleName: string;
    public readonly name: string;

    private readonly value: string;

    constructor(moduleName: string, name: string, value: string) {
        this.moduleName = moduleName;
        this.name = name;
        this.value = value;
    }

    get fqn(): string {
        return `${this.moduleName}.${this.name}`;
    }

    public emit(code: CodeMaker) {
        code.line(`${this.name} = "${this.value}"`);
    }
}

class Module {

    public readonly name: string;
    public readonly assembly: spec.Assembly;
    public readonly assemblyFilename: string;
    public readonly loadAssembly: boolean;

    private members: PythonCollectionNode[];
    private subModules: string[];

    constructor(ns: string, assembly: spec.Assembly, assemblyFilename: string, loadAssembly: boolean = false) {
        this.name = ns;
        this.assembly = assembly;
        this.assemblyFilename = assemblyFilename;
        this.loadAssembly = loadAssembly;

        this.members = [];
        this.subModules = [];
    }

    public addMember(member: PythonCollectionNode): PythonCollectionNode {
        this.members.push(member);
        return member;
    }

    public addSubmodule(module: string) {
        this.subModules.push(module);
    }

    public emit(code: CodeMaker) {
        // Before we write anything else, we need to write out our module headers, this
        // is where we handle stuff like imports, any required initialization, etc.
        code.line("import datetime");
        code.line("import enum");
        code.line("import typing");
        code.line();
        code.line("import jsii");
        code.line("import publication");
        code.line();
        code.line(this.generateImportFrom("jsii.compat", ["Protocol", "TypedDict"]));
        code.line("from jsii.python import classproperty");

        // Go over all of the modules that we need to import, and import them.
        // for (let [idx, modName] of this.importedModules.sort().entries()) {
        const dependencies = Object.keys(this.assembly.dependencies || {});
        for (const [idx, depName] of dependencies.sort().entries()) {
            // If this our first dependency, add a blank line to format our imports
            // slightly nicer.
            if (idx === 0) {
                code.line();
            }

            code.line(`import ${toPythonModuleName(depName)}`);
        }

        const moduleRe = new RegExp(`^${escapeStringRegexp(this.name)}\.`);
        for (const [idx, subModule] of this.subModules.sort().entries()) {
            // If this our first subModule, add a blank line to format our imports
            // slightly nicer.
            if (idx === 0) {
                code.line();
            }

            code.line(`from . import ${subModule.replace(moduleRe, "")}`);
        }

        // Determine if we need to write out the kernel load line.
        if (this.loadAssembly) {
            code.line(
                `__jsii_assembly__ = jsii.JSIIAssembly.load(` +
                `"${this.assembly.name}", ` +
                `"${this.assembly.version}", ` +
                `__name__, ` +
                `"${this.assemblyFilename}")`
            );
        }

        // Now that we've gotten all of the module header stuff done, we need to go
        // through and actually write out the meat of our module.
        for (const member of sortMembers(this.members)) {
            member.emit(code);
        }

        // Whatever names we've exported, we'll write out our __all__ that lists them.
        code.line(`__all__ = [${this.getExportedNames().map(s => `"${s}"`).join(", ")}]`);

        // Finally, we'll use publication to ensure that all of the non-public names
        // get hidden from dir(), tab-complete, etc.
        code.line();
        code.line("publication.publish()");
    }

    private getExportedNames(): string[] {
        // We assume that anything that is a member of this module, will be exported by
        // this module.
        const exportedNames = this.members.map(m => m.name);

        // If this module will be outputting the Assembly, then we also want to export
        // our assembly variable.
        if (this.loadAssembly) {
            exportedNames.push("__jsii_assembly__");
        }

        // We also need to export all of our submodules.
        const moduleRe = new RegExp(`^${escapeStringRegexp(this.name)}\.`);
        exportedNames.push(...this.subModules.map(item => item.replace(moduleRe, "")));

        return exportedNames.sort();

    }

    private generateImportFrom(from: string, names: string[]): string {
        // Whenever we import something, we want to prefix all of the names we're
        // importing with an underscore to indicate that these names are private. We
        // do this, because otherwise we could get clashes in the names we use, and the
        // names of exported classes.
        const importNames = names.map(n => `${n} as _${n}`);
        return `from ${from} import ${importNames.join(", ")}`;
    }
}

class PythonGenerator extends Generator {

    private currentMember?: PythonCollectionNode;
    private modules: Module[];
    private moduleStack: Module[];

    constructor(options = new GeneratorOptions()) {
        super(options);

        this.code.openBlockFormatter = s => `${s}:`;
        this.code.closeBlockFormatter = _s => "";

        this.currentMember = undefined;
        this.modules = [];
        this.moduleStack = [];
    }

    protected getAssemblyOutputDir(mod: spec.Assembly) {
        return path.join("src", toPythonModuleFilename(toPythonModuleName(mod.name)), "_jsii");
    }

    protected onBeginAssembly(assm: spec.Assembly, _fingerprint: boolean) {
        // We need to write out an __init__.py for our _jsii package so that
        // importlib.resources will be able to load our assembly from it.
        const assemblyInitFilename = path.join(this.getAssemblyOutputDir(assm), "__init__.py");

        this.code.openFile(assemblyInitFilename);
        this.code.closeFile(assemblyInitFilename);
    }

    protected onEndAssembly(assm: spec.Assembly, _fingerprint: boolean) {
        const packageName = toPythonPackageName(assm.name);
        const topLevelModuleName = toPythonModuleName(packageName);
        const moduleNames = this.modules.map(m => m.name);
        const pyTypedFilename = path.join("src", toPythonModuleFilename(topLevelModuleName), "py.typed");

        moduleNames.push(`${topLevelModuleName}._jsii`);
        moduleNames.sort();

        // We need to write out our packaging for the Python ecosystem here.
        // TODO:
        //      - Author
        //      - README
        //      - License
        //      - Classifiers
        //      - install_requires
        this.code.openFile("setup.py");
        this.code.line("import setuptools");
        this.code.indent("setuptools.setup(");
        this.code.line(`name="${packageName}",`);
        this.code.line(`version="${assm.version}",`);
        this.code.line(`description="${assm.description}",`);
        this.code.line(`url="${assm.homepage}",`);
        this.code.line('package_dir={"": "src"},');
        this.code.line(`packages=[${moduleNames.map(m => `"${m}"`).join(",")}],`);
        this.code.line(`package_data={"${topLevelModuleName}": ["py.typed"], "${topLevelModuleName}._jsii": ["*.jsii.tgz"]},`);
        this.code.line('python_requires=">=3.6",');
        this.code.line(`install_requires=["publication"],`);
        this.code.unindent(")");
        this.code.closeFile("setup.py");

        // Because we're good citizens, we're going to go ahead and support pyproject.toml
        // as well.
        // TODO: Might be easier to just use a TOML library to write this out.
        this.code.openFile("pyproject.toml");
        this.code.line("[build-system]");
        this.code.line('requires = ["setuptools", "wheel"]');
        this.code.closeFile("pyproject.toml");

        // We also need to write out a MANIFEST.in to ensure that all of our required
        // files are included.
        this.code.openFile("MANIFEST.in");
        this.code.line("include pyproject.toml");
        this.code.closeFile("MANIFEST.in");

        // We also need to write out a py.typed file, to Signal to MyPy that these files
        // are safe to use for typechecking.
        this.code.openFile(pyTypedFilename);
        this.code.closeFile(pyTypedFilename);
    }

    protected onBeginNamespace(ns: string) {
        const moduleName = toPythonModuleName(ns);
        const loadAssembly = this.assembly.name === ns ? true : false;
        const mod = new Module(moduleName, this.assembly, this.getAssemblyFileName(), loadAssembly);

        for (const parentMod of this.moduleStack) {
            parentMod.addSubmodule(moduleName);
        }

        this.modules.push(mod);
        this.moduleStack.push(mod);
    }

    protected onEndNamespace(_ns: string) {
        const module = this.moduleStack.pop() as Module;
        const moduleFilename = path.join("src", toPythonModuleFilename(module.name), "__init__.py");

        this.code.openFile(moduleFilename);
        module.emit(this.code);
        this.code.closeFile(moduleFilename);
    }

    protected onBeginClass(cls: spec.ClassType, _abstract: boolean | undefined) {
        const currentModule = this.currentModule();

        // TODO: Figure out what to do with abstract here.

        this.currentMember = currentModule.addMember(
            new Class(
                currentModule.name,
                toPythonIdentifier(cls.name),
                cls.fqn,
                (cls.base !== undefined ? [cls.base] : []).map(b => toPythonType(b)),
            )
        );

        if (cls.initializer !== undefined) {
            this.currentMember.addMember(
                new Initializer(
                    currentModule.name,
                    this.currentMember,
                    "__init__",
                    undefined,
                    cls.initializer.parameters || [],
                    cls.initializer.returns,
                    this.getliftedProp(cls.initializer),
                )
            );
        }
    }

    protected onEndClass(_cls: spec.ClassType) {
        this.currentMember = undefined;
    }

    protected onStaticMethod(_cls: spec.ClassType, method: spec.Method) {
        this.currentMember!.addMember(
            new StaticMethod(
                this.currentModule().name,
                this.currentMember!,
                toPythonMethodName(method.name!),
                method.name!,
                method.parameters || [],
                method.returns,
                this.getliftedProp(method),
            )
        );
    }

    protected onMethod(_cls: spec.ClassType, method: spec.Method) {
        this.currentMember!.addMember(
            new Method(
                this.currentModule().name,
                this.currentMember!,
                toPythonMethodName(method.name!),
                method.name!,
                method.parameters || [],
                method.returns,
                this.getliftedProp(method),
            )
        );
    }

    protected onStaticProperty(_cls: spec.ClassType, prop: spec.Property) {
        this.currentMember!.addMember(
            new StaticProperty(
                this.currentModule().name,
                toPythonPropertyName(prop.name!),
                prop.name!,
                prop.type,
                prop.immutable || false
            )
        );
    }

    protected onProperty(_cls: spec.ClassType, prop: spec.Property) {
        this.currentMember!.addMember(
            new Property(
                this.currentModule().name,
                toPythonPropertyName(prop.name!),
                prop.name!,
                prop.type,
                prop.immutable || false,
            )
        );
    }

    protected onBeginInterface(ifc: spec.InterfaceType) {
        const currentModule = this.currentModule();

        if (ifc.datatype) {
            this.currentMember = currentModule.addMember(
                new TypedDict(
                    currentModule.name,
                    toPythonIdentifier(ifc.name)
                )
            );
        } else {
            this.currentMember = currentModule.addMember(
                new Interface(
                    currentModule.name,
                    toPythonIdentifier(ifc.name),
                    (ifc.interfaces || []).map(i => toPythonType(i))
                )
            );
        }
    }

    protected onEndInterface(_ifc: spec.InterfaceType) {
        this.currentMember = undefined;
    }

    protected onInterfaceMethod(ifc: spec.InterfaceType, method: spec.Method) {
        if (ifc.datatype) {
            throw new Error("Cannot have a method on a data type.");
        }

        this.currentMember!.addMember(
            new InterfaceMethod(
                this.currentModule().name,
                this.currentMember!,
                toPythonMethodName(method.name!),
                method.name!,
                method.parameters || [],
                method.returns,
                this.getliftedProp(method),
            )
        );
    }

    protected onInterfaceProperty(ifc: spec.InterfaceType, prop: spec.Property) {
        if (ifc.datatype) {
            this.currentMember!.addMember(
                new TypedDictProperty(
                    this.currentModule().name,
                    toPythonIdentifier(prop.name!),
                    prop.type,
                )
            );
        } else {
            this.currentMember!.addMember(
                new InterfaceProperty(
                    this.currentModule().name,
                    toPythonPropertyName(prop.name!),
                    prop.name!,
                    prop.type,
                    true,
                )
            );
        }
    }

    protected onBeginEnum(enm: spec.EnumType) {
        const currentModule = this.currentModule();
        const newMember = new Enum(currentModule.name, toPythonIdentifier(enm.name));

        this.currentMember = currentModule.addMember(newMember);
    }

    protected onEndEnum(_enm: spec.EnumType) {
        this.currentMember = undefined;
    }

    protected onEnumMember(_enm: spec.EnumType, member: spec.EnumMember) {
        this.currentMember!.addMember(
            new EnumMember(
                this.currentModule().name,
                toPythonIdentifier(member.name),
                member.name
            )
        );
    }

    // Not Currently Used

    protected onInterfaceMethodOverload(_ifc: spec.InterfaceType, _overload: spec.Method, _originalMethod: spec.Method) {
        debug("onInterfaceMethodOverload");
        throw new Error("Unhandled Type: InterfaceMethodOverload");
    }

    protected onUnionProperty(_cls: spec.ClassType, _prop: spec.Property, _union: spec.UnionTypeReference) {
        debug("onUnionProperty");
        throw new Error("Unhandled Type: UnionProperty");
    }

    protected onMethodOverload(_cls: spec.ClassType, _overload: spec.Method, _originalMethod: spec.Method) {
        debug("onMethodOverload");
        throw new Error("Unhandled Type: MethodOverload");
    }

    protected onStaticMethodOverload(_cls: spec.ClassType, _overload: spec.Method, _originalMethod: spec.Method) {
        debug("onStaticMethodOverload");
        throw new Error("Unhandled Type: StaticMethodOverload");
    }

    // End Not Currently Used

    private getliftedProp(method: spec.Method): spec.InterfaceType | undefined {
        // If there are parameters to this method, and if the last parameter's type is
        // a datatype interface, then we want to lift the members of that last paramter
        // as keyword arguments to this function.
        if (method.parameters !== undefined && method.parameters.length >= 1) {
            const lastParameter = method.parameters.slice(-1)[0];
            if (spec.isNamedTypeReference(lastParameter.type)) {
                const lastParameterType = this.findType(lastParameter.type.fqn);
                if (spec.isInterfaceType(lastParameterType) && lastParameterType.datatype) {
                    return lastParameterType;
                }
            }
        }

        return undefined;
    }

    private currentModule(): Module {
        return this.moduleStack.slice(-1)[0];
    }
}
