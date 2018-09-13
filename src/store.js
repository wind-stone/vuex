import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert } from './util'

let Vue // bind on install

export class Store {
  /**
   * Store 的构造函数
   */
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    if (process.env.NODE_ENV !== 'production') {
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // store internal state
    this._committing = false
    this._actions = Object.create(null)
    this._actionSubscribers = []
    this._mutations = Object.create(null)
    this._wrappedGetters = Object.create(null)
    // 创建模块集合，this._modules.root 是根模块，this._modules.root._children 包含着所有的子模块（子模块再递归包含孙模块）
    this._modules = new ModuleCollection(options)
    this._modulesNamespaceMap = Object.create(null)
    this._subscribers = []
    this._watcherVM = new Vue()

    // bind commit and dispatch to self
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict

    // 根模块的 state 对象
    const state = this._modules.root.state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    // 安装根模块（递归地安装子模块，并收集所有模块的 getters 到 _wrappedGetters）
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    // 重置 store 的 vm 属性，将 store 实例的 state 和 getter 分别映射到 vm 的 data 和 computed 属性上
    resetStoreVM(this, state)

    // apply plugins
    plugins.forEach(plugin => plugin(this))

    if (Vue.config.devtools) {
      devtoolPlugin(this)
    }
  }

  /**
   * 获取 store.state
   */
  get state () {
    return this._vm._data.$$state
  }

  /**
   * 不允许直接设置 store.state，而是使用 store.replaceState()
   */
  set state (v) {
    if (process.env.NODE_ENV !== 'production') {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  /**
   * 提交 mutation
   * @param {*} _type mutation 的名称（带命名空间）
   * @param {*} _payload payload
   * @param {*} _options options 对象，目前仅有 root 属性，表明是否提交根的 mutation
   */
  commit (_type, _payload, _options) {
    // check object-style commit
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })
    // mutation 执行完之后，执行订阅了 mutation 改变的回调函数
    this._subscribers.forEach(sub => sub(mutation, this.state))

    if (
      process.env.NODE_ENV !== 'production' &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  /**
   * 分发 action
   * @param {*} _type action 的名称（带命名空间）
   * @param {*} _payload payload
   */
  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    const entry = this._actions[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    // action 执行前，先调用订阅 action 变化的回调函数
    this._actionSubscribers.forEach(sub => sub(action, this.state))

    // 若 action 有多个回调，都执行完了才算 resolve
    return entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)
  }

  /**
   * 添加 mutation 订阅函数
   */
  subscribe (fn) {
    return genericSubscribe(fn, this._subscribers)
  }

  /**
   * 添加 action 订阅函数
   */
  subscribeAction (fn) {
    return genericSubscribe(fn, this._actionSubscribers)
  }

  /**
   * 响应式监听
   */
  watch (getter, cb, options) {
    if (process.env.NODE_ENV !== 'production') {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  /**
   * 替换 state
   */
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  /**
   * 注册动态模块
   */
  registerModule (path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    this._modules.register(path, rawModule)
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    resetStoreVM(this, this.state)
  }

  /**
   * 卸载动态模块
   */
  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    // 从父模块里删除该模块
    this._modules.unregister(path)
    this._withCommit(() => {
      // 从父模块的 state 里删除该模块的 state
      const parentState = getNestedState(this.state, path.slice(0, -1))
      Vue.delete(parentState, path[path.length - 1])
    })
    resetStore(this)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  /**
   * 在此函数里，可以直接修改 state，不需要通过 mutation
   */
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

/**
 * 添加 mutation、action 订阅函数
 */
function genericSubscribe (fn, subs) {
  if (subs.indexOf(fn) < 0) {
    subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

/**
 * 重置 store
 */
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

/**
 * 重置 store 实例的 vm 属性，并将 store 的 state 和 getters 分别映射到 vm 的 data 属性 和 computed 属性上，
 * 从而实现 getter 随 state 的变化而变化，以及 getter 的惰性获取能力，类似于 vue 实例的 computed 随 data 的变化而变化一样
 * @param {*} store store 实例
 * @param {*} state store 的根 state
 * @param {*} hot 用于热部署时
 */
function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    computed[key] = () => fn(store)
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  Vue.config.silent = true
  store._vm = new Vue({
    data: {
      // 将 store.state 作为 Vue 实例的 data 的 $$state 属性，从而实现 store.state 是响应式的
      $$state: state
    },
    // 将 store.getters 作为 Vue 实例的计算属性，从而实现 store.getter 随着 store._vm_data.$$state 即 store.state 的改变重新计算出新值，若是值改变了，会通知外部依赖于该 getter 的 watcher
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  // 开启严格模式
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

/**
 * 安装模块
 * @param {*} store store 实例
 * @param {*} rootState 根模块的 state 对象
 * @param {*} path 模块路径
 * @param {*} module 模块
 * @param {*} hot 是否保留原来的 state，在重置 modules 时、动态注册 module 时会用到
 */
function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  if (module.namespaced) {
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  // 将子模块的 state 挂载到父模块的 state 上，如此便形成 state 链
  // 注意：理论上不能直接给 state 添加属性，但此处通过 _withCommit 解锁🔓，给 state 添加属性，key 为子模块的名称，value 为子模块的 state 对象
  if (!isRoot && !hot) {
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      Vue.set(parentState, moduleName, module.state)
    })
  }

  const local = module.context = makeLocalContext(store, namespace, path)

  // 遍历 mutation，并注册
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  // 遍历 action，并注册
  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  // 遍历 getter，并注册
  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  // 递归地安装子模块
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 *
 * 创建绑定在给定命名空间上的局部 state、getters、commit、dispatch，若没有命名空间，返回根实例上的
 * @param {object} store store 实例
 * @param {string} namespace 命名空间
 * @param {object} path 模块路径
 */
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      // dispatch 的第三个参数 options 的 root 为 tree 时，分发根模块上的 action，否则分发命名空间模块上的 action
      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      // commit 的第三个参数 options 的 root 为 tree 时，提交根模块上的 mutation，否则提交命名空间模块上的 mutation
      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  // getters、state 必须实时获取
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

/**
 * 实时获取命名空间模块的 getters（遍历 store.getters，将符合命名空间的 getter 筛选出来）
 * @param {*} store store 实例
 * @param {*} namespace 命名空间
 */
function makeLocalGetters (store, namespace) {
  const gettersProxy = {}

  const splitPos = namespace.length
  // 每次获取时，遍历 store.getters 上的每个 getter，将符合命名空间的 getter 加入到 gettersProxy
  Object.keys(store.getters).forEach(type => {
    // skip if the target getter is not match this namespace
    if (type.slice(0, splitPos) !== namespace) return

    // extract local getter type
    const localType = type.slice(splitPos)

    // Add a port to the getters proxy.
    // Define as getter property because
    // we do not want to evaluate the getters in this time.
    Object.defineProperty(gettersProxy, localType, {
      get: () => store.getters[type],
      enumerable: true
    })
  })

  return gettersProxy
}

/**
 * 注册 mutations
 * @param {*} store store 实例
 * @param {*} type mutation 的名称（带命名空间）
 * @param {*} handler mutation 回调函数
 * @param {*} local 绑定命名空间的上下文对象
 */
function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
  entry.push(function wrappedMutationHandler (payload) {
    handler.call(store, local.state, payload)
  })
}

/**
 * 注册 actions
 * @param {*} store store 实例
 * @param {*} type action 的名称（带命名空间）
 * @param {*} handler action 回调函数
 * @param {*} local 绑定命名空间的上下文对象
 */
function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler (payload, cb) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload, cb)
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

/**
 * 注册 getters
 * @param {*} store store 实例
 * @param {*} type getter 的名称（带命名空间）
 * @param {*} rawGetter getter
 * @param {*} local 绑定命名空间的上下文对象
 */
function registerGetter (store, type, rawGetter, local) {
  if (store._wrappedGetters[type]) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

/**
 * 开启严格模式（开启后只能通过 mutation 修改 state）
 */
function enableStrictMode (store) {
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (process.env.NODE_ENV !== 'production') {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

/**
 * 获取嵌套的子模块的 state
 * @param {*} state 根 state
 * @param {*} path 模块路径
 */
function getNestedState (state, path) {
  return path.length
    ? path.reduce((state, key) => state[key], state)
    : state
}

/**
 * 统一调用 commit、dispatch 的参数
 */
function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (process.env.NODE_ENV !== 'production') {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

/**
 * Vuex 作为 Vue 插件，Vue.use(Vuex) 时，会调用插件的 install 方法
 */
export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  applyMixin(Vue)
}
