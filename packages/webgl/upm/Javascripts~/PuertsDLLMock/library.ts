import { $GetArgumentFinalValue } from "./mixins/getFromJSArgument";

/**
 * 一次函数调用的info
 * 对应v8::FunctionCallbackInfo
 */
export class FunctionCallbackInfo {
    args: any[];
    returnValue: any;

    constructor(args: any[]) {
        this.args = args;
    }

    recycle(): void {
        this.args = null;
        this.returnValue = void 0;
    }
}

/**
 * 把FunctionCallbackInfo以及其参数转化为c#可用的intptr
 */
export class FunctionCallbackInfoPtrManager {
    // FunctionCallbackInfo的列表，以列表的index作为IntPtr的值
    private infos: FunctionCallbackInfo[] = [new FunctionCallbackInfo([0])] // 这里原本只是个普通的0
    // FunctionCallbackInfo用完后，将其序号放入“回收列表”，下次就能继续服用该index，而不必让infos数组无限扩展下去
    private freeInfosIndex: MockIntPtr[] = [];
    private freeCallbackInfoMemoryByLength: {
        [length: number]: number[]
    } = {};
    private freeRefMemory: number[] = []

    private readonly argumentValueLengthIn32 = 4;
    private readonly engine: PuertsJSEngine;

    constructor(engine: PuertsJSEngine) {
        this.engine = engine;
    }

    private allocCallbackInfoMemory(argslength: number): number {
        const cacheArray = this.freeCallbackInfoMemoryByLength[argslength];
        if (cacheArray && cacheArray.length) {
            return cacheArray.pop();

        } else {
            return this.engine.unityApi._malloc((argslength * this.argumentValueLengthIn32 + 1) << 2);
        }
    }
    private allocRefMemory() {
        if (this.freeRefMemory.length) return this.freeRefMemory.pop();
        return this.engine.unityApi._malloc(this.argumentValueLengthIn32 << 2);
    }
    private recycleRefMemory(bufferptr: number) {
        if (this.freeRefMemory.length > 20) {
            this.engine.unityApi._free(bufferptr);
        } 
        else {
            this.freeRefMemory.push(bufferptr);
        }
    }
    private recycleCallbackInfoMemory(bufferptr: number, args: any[]) {
        const argslength = args.length;
        if (!this.freeCallbackInfoMemoryByLength[argslength] && argslength < 5) {
            this.freeCallbackInfoMemoryByLength[argslength] = [];
        }
        const cacheArray = this.freeCallbackInfoMemoryByLength[argslength];
        if (!cacheArray) return;

        const bufferPtrIn32 = bufferptr << 2;
        args.forEach((arg, i) => {
            if (arg instanceof Array && arg.length == 1) {
                this.recycleRefMemory(this.engine.unityApi.HEAP32[bufferPtrIn32 + i * this.argumentValueLengthIn32 + 1])
            }
        })
        // 拍脑袋定的最大缓存个数大小。 50 - 参数个数 * 10
        if (cacheArray.length > (50 - argslength * 10)) {
            this.engine.unityApi._free(bufferptr);

        } else {
            cacheArray.push(bufferptr);
        }
    }
    /**
     * intptr的格式为id左移四位
     * 
     * 右侧四位，是为了在右四位存储参数的序号，这样可以用于表示callbackinfo参数的intptr
     */
    // static GetMockPointer(args: any[]): MockIntPtr {
    //     let index: number;
    //     index = this.freeInfosIndex.pop();
    //     // index最小为1
    //     if (index) {
    //         this.infos[index].args = args;
    //     } else {
    //         index = this.infos.push(new FunctionCallbackInfo(args)) - 1;
    //     }
    //     return index << 4;
    // }
    GetMockPointer(args: any[]): MockIntPtr {
        var bufferPtrIn8 = this.allocCallbackInfoMemory(args.length);

        let index: number;
        index = this.freeInfosIndex.pop();
        // index最小为1
        if (index) {
            this.infos[index].args = args;
        } else {
            index = this.infos.push(new FunctionCallbackInfo(args)) - 1;
        }

        const bufferPtrIn32 = bufferPtrIn8 >> 2
        this.engine.unityApi.HEAP32[bufferPtrIn32] = index;
        for (var i = 0; i < args.length; i++) {
            // init each value
            const jsValueType = GetType(this.engine, args[i]);
            const jsValuePtr = bufferPtrIn32 + i * this.argumentValueLengthIn32 + 1;

            this.engine.unityApi.HEAP32[jsValuePtr] = jsValueType;    // jsvaluetype
            if (jsValueType == 4 || jsValueType == 512) {
                // number or date
                this.engine.unityApi.HEAPF32[jsValuePtr + 1] = $GetArgumentFinalValue(
                    this.engine, args[i], jsValueType, 0
                );    // value

            } else if (jsValueType == 64 && args[i] instanceof Array && args[i].length == 1) {
                // maybe a ref
                this.engine.unityApi.HEAP32[jsValuePtr + 1] = $GetArgumentFinalValue(
                    this.engine, args[i], jsValueType,
                    0
                );   

                const refPtrIn8 = this.engine.unityApi.HEAP32[jsValuePtr + 2] = this.allocRefMemory();
                const refPtr = refPtrIn8 >> 2
                const refValueType = this.engine.unityApi.HEAP32[refPtr] = GetType(this.engine, args[i][0])
                if (refValueType == 4 || refValueType == 512) {
                    // number or date
                    this.engine.unityApi.HEAPF32[refPtr + 1] = $GetArgumentFinalValue(
                        this.engine, args[i][0], refValueType, 0
                    );    // value

                } else {
                    this.engine.unityApi.HEAP32[refPtr + 1] = $GetArgumentFinalValue(
                        this.engine, args[i][0], refValueType,
                        (refPtr + 2) << 2
                    );  
                } 
                this.engine.unityApi.HEAP32[refPtr + 3] = bufferPtrIn8; // a pointer to the info

            } else {
                // other
                this.engine.unityApi.HEAP32[jsValuePtr + 1] = $GetArgumentFinalValue(
                    this.engine, args[i], jsValueType,
                    (jsValuePtr + 2) << 2
                );   
            }
            this.engine.unityApi.HEAP32[jsValuePtr + 3] = bufferPtrIn8; // a pointer to the info
        }
        return bufferPtrIn8;
    }

    // static GetByMockPointer(intptr: MockIntPtr): FunctionCallbackInfo {
    //     return this.infos[intptr >> 4];
    // }
    GetByMockPointer(ptrIn8: MockIntPtr): FunctionCallbackInfo {
        const ptrIn32 = ptrIn8 >> 2;
        const index = this.engine.unityApi.HEAP32[ptrIn32];
        return this.infos[index];
    }

    GetReturnValueAndRecycle(ptrIn8: MockIntPtr): any {
        const ptrIn32 = ptrIn8 >> 2;
        const index = this.engine.unityApi.HEAP32[ptrIn32];

        let info = this.infos[index];
        let ret = info.returnValue;
        this.recycleCallbackInfoMemory(ptrIn8, info.args);
        info.recycle();
        this.freeInfosIndex.push(index);
        return ret;
    }

    ReleaseByMockIntPtr(ptrIn8: MockIntPtr) {
        const ptrIn32 = ptrIn8 >> 2;
        const index = this.engine.unityApi.HEAP32[ptrIn32];

        let info = this.infos[index];
        this.recycleCallbackInfoMemory(ptrIn8, info.args);
        info.recycle();
        this.freeInfosIndex.push(index);
    }

    GetArgsByMockIntPtr<T>(valuePtrIn8: MockIntPtr): T {
        const infoptrIn8 = this.engine.unityApi.HEAP32[(valuePtrIn8 >> 2) + 3];
        const callbackInfoIndex = this.engine.unityApi.HEAP32[infoptrIn8 >> 2];

        const argsIndex = (valuePtrIn8 - infoptrIn8 - 4) / (4 * this.argumentValueLengthIn32);
        const info: FunctionCallbackInfo = this.infos[callbackInfoIndex];
        return info.args[argsIndex] as T;
    }
}

export class Ref<T> {
    public value: T
}

/**
 * 代表一个JSFunction
 */
export class JSFunction {
    public _func: (...args: any[]) => any;

    public readonly id: number;

    public args: any[] = [];

    public lastException: Error = null;

    constructor(id: number, func: (...args: any[]) => any) {
        this._func = func;
        this.id = id;
    }
    public invoke() {
        var args = [...this.args];
        this.args.length = 0;
        return this._func.apply(this, args);
    }
}

/**
 * 代表一个JSObject
 */
export class JSObject {
    private _obj: object

    public id: number

    constructor(id: number, obj: object) {
        this._obj = obj;
        this.id = id;
    }

    public getObject(): object {
        return this._obj;
    }
}

export class jsFunctionOrObjectFactory {
    private static regularID: number = 1;
    private static idMap = new WeakMap<Function | object, number>();
    private static jsFuncOrObjectKV: { [id: number]: JSFunction | JSObject } = {};

    public static getOrCreateJSFunction(funcValue: (...args: any[]) => any): JSFunction {
        let id = jsFunctionOrObjectFactory.idMap.get(funcValue);
        if (id) {
            return jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] as JSFunction;
        }

        id = jsFunctionOrObjectFactory.regularID++;
        const func = new JSFunction(id, funcValue);
        jsFunctionOrObjectFactory.idMap.set(funcValue, id);
        jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] = func;

        return func;
    }

    public static getOrCreateJSObject(obj: object) {
        let id = jsFunctionOrObjectFactory.idMap.get(obj);
        if (id) {
            return jsFunctionOrObjectFactory.jsFuncOrObjectKV[id];
        }

        id = jsFunctionOrObjectFactory.regularID++;
        const jsObject = new JSObject(id, obj);
        jsFunctionOrObjectFactory.idMap.set(obj, id);
        jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] = jsObject;

        return jsObject;
    }

    public static getJSObjectById(id: number): JSObject {
        return jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] as JSObject;
    }

    public static removeJSObjectById(id: number): void {
        const jsObject = jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] as JSObject;
        jsFunctionOrObjectFactory.idMap.delete(jsObject.getObject());
        delete jsFunctionOrObjectFactory.jsFuncOrObjectKV[id];
    }

    public static getJSFunctionById(id: number): JSFunction {
        return jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] as JSFunction;
    }

    public static removeJSFunctionById(id: number): void {
        const jsFunc = jsFunctionOrObjectFactory.jsFuncOrObjectKV[id] as JSFunction;
        jsFunctionOrObjectFactory.idMap.delete(jsFunc._func);
        delete jsFunctionOrObjectFactory.jsFuncOrObjectKV[id];
    }
}

/**
 * CSharp对象记录表，记录所有CSharp对象并分配id
 * 和puerts.dll所做的一样
 */
export class CSharpObjectMap {
    public classes: {
        (): void;
        createFromCS(csID: number): any;
        [key: string]: any;
    }[] = [null];

    private nativeObjectKV: Map<CSIdentifier, WeakRef<any>> = new Map();
    // private nativeObjectKV: { [objectID: CSIdentifier]: WeakRef<any> } = {};
    // private csIDWeakMap: WeakMap<any, CSIdentifier> = new WeakMap();

    public namesToClassesID: { [name: string]: number } = {};
    public classIDWeakMap = new WeakMap();

    constructor() {
        this._memoryDebug && setInterval(() => {
            console.log('addCalled', this.addCalled);
            console.log('removeCalled', this.removeCalled);
            console.log('wr', this.nativeObjectKV.size);
        }, 1000)
    }

    private _memoryDebug = false
    private addCalled: number = 0;
    private removeCalled: number = 0;

    add(csID: CSIdentifier, obj: any) {
        this._memoryDebug && this.addCalled++;
        // this.nativeObjectKV[csID] = createWeakRef(obj);
        // this.csIDWeakMap.set(obj, csID);
        this.nativeObjectKV.set(csID, createWeakRef(obj));
        Object.defineProperty(obj, '_puerts_csid_', {
            value: csID
        })
    }
    remove(csID: CSIdentifier) {
        this._memoryDebug && this.removeCalled++;
        // delete this.nativeObjectKV[csID];
        this.nativeObjectKV.delete(csID);
    }
    findOrAddObject(csID: CSIdentifier, classID: number) {
        let ret = this.nativeObjectKV.get(csID);
        // let ret = this.nativeObjectKV[csID];
        if (ret && (ret = ret.deref())) {
            return ret;
        }
        ret = this.classes[classID].createFromCS(csID);
        // this.add(csID, ret); 构造函数里负责调用
        return ret;
    }
    getCSIdentifierFromObject(obj: any) {
        // return this.csIDWeakMap.get(obj);
        return obj ? obj._puerts_csid_ : 0;
    }
}

interface Destructor {
    (heldValue: CSIdentifier): any,
    ref: number
};
var destructors: { [csIdentifier: CSIdentifier]: Destructor } = {};

declare let global: any;
global = global || globalThis || window;
global.global = global;
export { global };

declare const WXWeakRef: any;
const createWeakRef: <T extends object>(obj: any) => WeakRef<T> = (function () {
    if (typeof WeakRef == 'undefined') {
        if (typeof WXWeakRef == 'undefined') {
            console.error("WeakRef is not defined. maybe you should use newer environment");
            return function (obj: any) {
                return { deref() { return obj } }
            }
        }

        console.warn("using WXWeakRef");
        return function (obj: any) {
            return new WXWeakRef(obj);
        }
    }
    return function (obj: any) {
        return new WeakRef(obj);
    }
})();
export { createWeakRef }
/**
 * JS对象生命周期监听
 */
interface FinalizationRegistryMock<T> extends FinalizationRegistry<T> { }
class FinalizationRegistryMock<T> {
    private _handler: (value: T) => void;

    private refs: WeakRef<any>[] = [];
    private helds: T[] = [];
    private availableIndex: number[] = [];

    constructor(handler: (value: T) => void) {
        console.warn("FinalizationRegister is not defined. using FinalizationRegistryMock");
        global._puerts_registry = this;
        this._handler = handler;
    }
    public register(obj: object, heldValue: T) {
        if (this.availableIndex.length) {
            const index = this.availableIndex.pop();
            this.refs[index] = createWeakRef(obj);
            this.helds[index] = heldValue;

        } else {
            this.refs.push(createWeakRef(obj));
            this.helds.push(heldValue);
        }
    }

    /**
     * 清除可能已经失效的WeakRef
     */
    private iteratePosition: number = 0;
    public cleanup(part: number = 1) {
        const stepCount = this.refs.length / part;
        let i = this.iteratePosition;
        for (
            let currentStep = 0;
            i < this.refs.length && currentStep < stepCount;
            i = (i == this.refs.length - 1 ? 0 : i + 1), currentStep++
        ) {
            if (this.refs[i] == null) {
                continue;
            }
            if (!this.refs[i].deref()) {
                // 目前没有内存整理能力，如果游戏中期ref很多但后期少了，这里就会白费遍历次数
                // 但遍历也只是一句==和continue，浪费影响不大
                this.availableIndex.push(i);
                this.refs[i] = null;
                try {
                    this._handler(this.helds[i]);
                } catch (e) {
                    console.error(e);
                }
            }
        }
        this.iteratePosition = i;
    }
}
var registry: FinalizationRegistry<any> = null;
function init() {
    registry = new (
        typeof FinalizationRegistry == 'undefined' ? FinalizationRegistryMock : FinalizationRegistry
    )(function (heldValue: CSIdentifier) {
        var callback = destructors[heldValue];
        if (!callback) {
            throw new Error("cannot find destructor for " + heldValue);
        }
        if (--callback.ref == 0) {
            delete destructors[heldValue];
            callback(heldValue);
        }
    });
}
export function OnFinalize(obj: object, heldValue: any, callback: (heldValue: CSIdentifier) => any) {
    if (!registry) {
        init();
    }
    let originCallback = destructors[heldValue];
    if (originCallback) {
        // WeakRef内容释放时机可能比finalizationRegistry的触发更早，前面如果发现weakRef为空会重新创建对象
        // 但之前对象的finalizationRegistry最终又肯定会触发。
        // 所以如果遇到这个情况，需要给destructor加计数
        ++originCallback.ref;
    } else {
        (callback as Destructor).ref = 1;
        destructors[heldValue] = (callback as Destructor);
    }
    registry.register(obj, heldValue);
}

export namespace PuertsJSEngine {
    export interface EngineConstructorParam {
        UTF8ToString: (strPtr: CSString) => string,
        _malloc: (size: number) => number,
        _memcpy: (dst: number, src: number, size: number) => void,
        _free: (ptr: number) => void,
        stringToUTF8: (str: string, buffer: any, size: number) => any,
        lengthBytesUTF8: (str: string) => number,
        unityInstance: any,
    }
    export interface UnityAPI {
        UTF8ToString: (strPtr: CSString) => string,
        _malloc: (size: number) => number,
        _memcpy: (dst: number, src: number, size: number) => void,
        _free: (ptr: number) => void,
        stringToUTF8: (str: string, buffer: any, size: number) => any,
        lengthBytesUTF8: (str: string) => number,
        HEAP8: Uint8Array,
        HEAP32: Uint32Array,
        HEAPF32: Float32Array,
        HEAPF64: Float64Array,
        dynCall_viiiii: Function,
        dynCall_viii: Function,
        dynCall_iiiii: Function
    }
}

export class PuertsJSEngine {
    public readonly csharpObjectMap: CSharpObjectMap
    public readonly functionCallbackInfoPtrManager: FunctionCallbackInfoPtrManager

    public readonly unityApi: PuertsJSEngine.UnityAPI;

    public lastReturnCSResult: any = null;
    public lastException: Error = null;

    // 这四个是Puerts.WebGL里用于wasm通信的的CSharp Callback函数指针。
    public callV8Function: MockIntPtr;
    public callV8Constructor: MockIntPtr;
    public callV8Destructor: MockIntPtr;

    // 这两个是Puerts用的的真正的CSharp函数指针
    public GetJSArgumentsCallback: IntPtr
    public generalDestructor: IntPtr

    constructor(ctorParam: PuertsJSEngine.EngineConstructorParam) {
        this.csharpObjectMap = new CSharpObjectMap();
        this.functionCallbackInfoPtrManager = new FunctionCallbackInfoPtrManager(this);
        const { UTF8ToString, _malloc, _memcpy, _free, stringToUTF8, lengthBytesUTF8, unityInstance } = ctorParam;
        this.unityApi = {
            UTF8ToString,
            _malloc,
            _memcpy,
            _free,
            stringToUTF8,
            lengthBytesUTF8,

            dynCall_iiiii: unityInstance.dynCall_iiiii.bind(unityInstance),
            dynCall_viii: unityInstance.dynCall_viii.bind(unityInstance),
            dynCall_viiiii: unityInstance.dynCall_viiiii.bind(unityInstance),
            HEAP32: null,
            HEAP8: null,
            HEAPF32: null,
            HEAPF64: null
        };
        Object.defineProperty(this.unityApi, 'HEAP32', {
            get: function () {
                return unityInstance.HEAP32
            }
        })
        Object.defineProperty(this.unityApi, 'HEAPF32', {
            get: function () {
                return unityInstance.HEAPF32
            }
        })
        Object.defineProperty(this.unityApi, 'HEAPF64', {
            get: function () {
                return unityInstance.HEAPF64
            }
        })
        Object.defineProperty(this.unityApi, 'HEAP8', {
            get: function () {
                return unityInstance.HEAP8
            }
        });

        global.__tgjsEvalScript = typeof eval == "undefined" ? () => { } : eval;
        global.__tgjsSetPromiseRejectCallback = function (callback: (...args: any[]) => any) {
            if (typeof wx != 'undefined') {
                wx.onUnhandledRejection(callback);

            } else {
                window.addEventListener("unhandledrejection", callback);
            }
        }
        global.__puertsGetLastException = () => {
            return this.lastException
        }
    }

    JSStringToCSString(returnStr: string, /** out int */length: number) {
        if (returnStr === null || returnStr === undefined) {
            return 0;
        }
        var byteCount = this.unityApi.lengthBytesUTF8(returnStr);
        setOutValue32(this, length, byteCount);
        var buffer = this.unityApi._malloc(byteCount + 1);
        this.unityApi.stringToUTF8(returnStr, buffer, byteCount + 1);
        return buffer;
    }

    makeV8FunctionCallbackFunction(isStatic: bool, functionPtr: IntPtr, callbackIdx: number) {
        // 不能用箭头函数！此处返回的函数会赋值到具体的class上，其this指针有含义。
        const engine = this;
        return function (...args: any[]) {
            let callbackInfoPtr = engine.functionCallbackInfoPtrManager.GetMockPointer(args);
            try {
                engine.callV8FunctionCallback(
                    functionPtr,
                    // getIntPtrManager().GetPointerForJSValue(this),
                    isStatic ? 0 : engine.csharpObjectMap.getCSIdentifierFromObject(this),
                    callbackInfoPtr,
                    args.length,
                    callbackIdx
                );

                return engine.functionCallbackInfoPtrManager.GetReturnValueAndRecycle(callbackInfoPtr);

            } catch (e) {
                engine.functionCallbackInfoPtrManager.ReleaseByMockIntPtr(callbackInfoPtr,);
                throw e;
            }
        }
    }

    callV8FunctionCallback(functionPtr: IntPtr, selfPtr: CSIdentifier, infoIntPtr: MockIntPtr, paramLen: number, callbackIdx: number) {
        this.unityApi.dynCall_viiiii(this.callV8Function, functionPtr, infoIntPtr, selfPtr, paramLen, callbackIdx);
    }

    callV8ConstructorCallback(functionPtr: IntPtr, infoIntPtr: MockIntPtr, paramLen: number, callbackIdx: number) {
        return this.unityApi.dynCall_iiiii(this.callV8Constructor, functionPtr, infoIntPtr, paramLen, callbackIdx);
    }

    callV8DestructorCallback(functionPtr: IntPtr, selfPtr: CSIdentifier, callbackIdx: number) {
        this.unityApi.dynCall_viii(this.callV8Destructor, functionPtr, selfPtr, callbackIdx);
    }
}

export function GetType(engine: PuertsJSEngine, value: any): number {
    if (value === null || value === undefined) { return 1 }
    if (typeof value == 'number') { return 4 }
    if (typeof value == 'string') { return 8 }
    if (typeof value == 'boolean') { return 16 }
    if (typeof value == 'function') { return 256 }
    if (value instanceof Date) { return 512 }
    // if (value instanceof Array) { return 128 }
    if (value instanceof Array) { return 64 }
    if (value instanceof ArrayBuffer || value instanceof Uint8Array) { return 1024 }
    if (engine.csharpObjectMap.getCSIdentifierFromObject(value)) { return 32 }
    return 64;
}

export function makeBigInt(low: number, high: number) {
    return (BigInt(high >>> 0) << BigInt(32)) + BigInt(low >>> 0)
}

export function setOutValue32(engine: PuertsJSEngine, valuePtr: number, value: any) {
    engine.unityApi.HEAP32[valuePtr >> 2] = value;
}

export function setOutValue8(engine: PuertsJSEngine, valuePtr: number, value: any) {
    engine.unityApi.HEAP8[valuePtr] = value;
}