import Module from './module'
import { assert, forEachValue } from '../util'

export default class ModuleCollection {
  constructor (rawRootModule) {
    // register root module (Vuex.Store options)
    this.register([], rawRootModule, false)
  }

  /**
   * 根据路径，获取模块的父模块
   * @param {*} path 模块路径
   */
  get (path) {
    return path.reduce((module, key) => {
      return module.getChild(key)
    }, this.root)
  }

  /**
   * 获取模块的命名空间，只有 namespaced 为 true 的模块名称才会加入到命名空间字符串里
   * @param {*} path 模块路径
   */
  getNamespace (path) {
    let module = this.root
    return path.reduce((namespace, key) => {
      module = module.getChild(key)
      return namespace + (module.namespaced ? key + '/' : '')
    }, '')
  }

  update (rawRootModule) {
    update([], this.root, rawRootModule)
  }

  /**
   * 注册模块
   * @param {*} path 模块路径
   * @param {*} rawModule 模块定义对象
   * @param {*} runtime 模块是否是运行时添加的
   */
  register (path, rawModule, runtime = true) {
    if (process.env.NODE_ENV !== 'production') {
      assertRawModule(path, rawModule)
    }

    const newModule = new Module(rawModule, runtime)
    if (path.length === 0) {
      // 根模块
      this.root = newModule
    } else {
      // 获取模块的父模块，并将模块添加到父模块的 _children 对象里
      const parent = this.get(path.slice(0, -1))
      parent.addChild(path[path.length - 1], newModule)
    }

    // register nested modules
    // 递归注册模块下的所有子模块
    if (rawModule.modules) {
      forEachValue(rawModule.modules, (rawChildModule, key) => {
        this.register(path.concat(key), rawChildModule, runtime)
      })
    }
  }

  /**
   * 卸载模块
   * @param {*} path 模块路径
   */
  unregister (path) {
    const parent = this.get(path.slice(0, -1))
    const key = path[path.length - 1]
    if (!parent.getChild(key).runtime) return

    parent.removeChild(key)
  }
}

function update (path, targetModule, newModule) {
  if (process.env.NODE_ENV !== 'production') {
    assertRawModule(path, newModule)
  }

  // update target module
  targetModule.update(newModule)

  // update nested modules
  if (newModule.modules) {
    for (const key in newModule.modules) {
      if (!targetModule.getChild(key)) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[vuex] trying to add a new module '${key}' on hot reloading, ` +
            'manual reload is needed'
          )
        }
        return
      }
      update(
        path.concat(key),
        targetModule.getChild(key),
        newModule.modules[key]
      )
    }
  }
}

const functionAssert = {
  assert: value => typeof value === 'function',
  expected: 'function'
}

const objectAssert = {
  assert: value => typeof value === 'function' ||
    (typeof value === 'object' && typeof value.handler === 'function'),
  expected: 'function or object with "handler" function'
}

const assertTypes = {
  getters: functionAssert,
  mutations: functionAssert,
  actions: objectAssert
}

/**
 * 验证模块的有效性，需要满足：
 * 1、每一个 getter 都是函数
 * 2、每一个 mutation 都是函数
 * 3、每一个 action 都是函数 或是 有handler方法的对象
 *
 * @param {*} path 模块路径
 * @param {*} rawModule 模块定义对象
 *   {
 *     getters,
 *     mutations,
 *     actions
 *   }
 */
function assertRawModule (path, rawModule) {
  Object.keys(assertTypes).forEach(key => {
    if (!rawModule[key]) return

    const assertOptions = assertTypes[key]

    forEachValue(rawModule[key], (value, type) => {
      assert(
        assertOptions.assert(value),
        makeAssertionMessage(path, key, type, value, assertOptions.expected)
      )
    })
  })
}

function makeAssertionMessage (path, key, type, value, expected) {
  let buf = `${key} should be ${expected} but "${key}.${type}"`
  if (path.length > 0) {
    buf += ` in module "${path.join('.')}"`
  }
  buf += ` is ${JSON.stringify(value)}.`
  return buf
}
