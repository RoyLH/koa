
'use strict';

/**
 * Module dependencies.
 */

const isGeneratorFunction = require('is-generator-function'); // 判断是不是generator function
const debug = require('debug')('koa:application'); // 设置debug的`namespace`
const onFinished = require('on-finished'); // 执行回调 当http request 关闭结束或者有错误的时候
const response = require('./response'); // response对象
const compose = require('koa-compose'); // koa-compose
const context = require('./context'); // 请求上下文
const request = require('./request'); // request对象
const statuses = require('statuses'); // 只用了empty方法 statuses是一个对象 empty属性 status.empty = { 204: true, 205: true, 304: true }
const Emitter = require('events'); // node.js事件模块
const util = require('util'); // node.js断言库模块
const Stream = require('stream'); // node.js stream模块
const http = require('http'); // node.js http模块
const only = require('only'); // 用于返回对象的指定键值
const convert = require('koa-convert'); // 将基于koa生成器的中间件转换为基于Promise的中间件
const deprecate = require('depd')('koa'); // 给出一些信息 表示已经弃用
const { HttpError } = require('http-errors'); // http错误

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */
// 常在应用程序中这样写：
// const Koa = require('koa');
// const app = new Koa();
// 明显可见Koa是一个构造函数 / es6中的class（类） 也就是下面的Application类
// 而Application类又继承了 node.js的events模块
module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {boolean} [options.proxyIpHeader] proxy ip header, default to X-Forwarded-For
    * @param {boolean} [options.maxIpsCount] max ips read from proxy ip header, default to 0 (means infinity)
    *
    */

  constructor(options) {
    super();
    options = options || {};
    this.proxy = options.proxy || false; // 信任proxt headers 默认不信任
    this.subdomainOffset = options.subdomainOffset || 2; // 子域偏移
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For'; // proxy ip header 默认设为 X-Forwarded-For
    this.maxIpsCount = options.maxIpsCount || 0; // 从代理ip标头读取的最大ips，默认为0（表示无穷大）
    this.env = options.env || process.env.NODE_ENV || 'development'; // 环境 env 默认 development
    if (options.keys) this.keys = options.keys; // 签名的Cookie密钥
    this.middleware = []; // 中间件队列
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);
    if (util.inspect.custom) { // 可被用于声明自定义的查看函数
      this[util.inspect.custom] = this.inspect;
    }
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  listen(...args) { // 该listen方法 算是 node 原生 listen 方法的语法糖
    debug('listen');
    // this.callback()的执行结果肯定是一个函数（http.createServer() 中所需要的参数函数），这个函数无非就是形如 (req, res) => {...}
    const server = http.createServer(this.callback());
    // 根据传入的参数信息 进行端口监听
    return server.listen(...args);
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON() { // 只返回koa实例的 ['subdomainOffset', 'proxy', 'env'] 这三个属性
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect() { // 同toJSON() 只返回koa实例的 ['subdomainOffset', 'proxy', 'env'] 这三个属性
    return this.toJSON();
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  use(fn) {
    // 中间件必须是个函数 否则 抛出一个TypeError
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
    // 如果传入的函数是一个generator 函数，那么将会使用 koa-convert 模块把这个函数转化为一个 async 函数
    // koa-convert 这是一个很重要的模块，能将很多 koa1 时代下的中间件转化为 koa2 下可用的中间件
    // 并且注意到 Support for generators will be removed in v3.
    // 即在 koa3 中，将默认不支持 generator 函数作为中间件
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
      fn = convert(fn);
    }
    debug('use %s', fn._name || fn.name || '-');
    this.middleware.push(fn); // 将该中间件函数存入middleware队列
    return this; // 返回koa实例对象
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback() {
    // koa-compose 单从语义上看就是组合，其实就是将所有的koa中间件合并成一个匿名函数
    // 并且该匿名函数的返回值将是一个Promise
    const fn = compose(this.middleware);

    // 使用继承自events模块的listenerCount方法，统计error个数 如果存在error 通过events模块的on方法触发错误，用this.onerror函数处理
    if (!this.listenerCount('error')) this.on('error', this.onerror);

    // 可以看到 callback 方法返回的 handleRequest函数实际上就是 http.createServer()的参数函数
    const handleRequest = (req, res) => {
      const ctx = this.createContext(req, res); // 根据node.js原生的req, res对象生成一个ctx对象(请求上下文对象) 作为中间件函数的第一个参数
      return this.handleRequest(ctx, fn);
    };

    return handleRequest;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest(ctx, fnMiddleware) {
    const res = ctx.res; // 通过观看createContext方法中的 context.res = request.res = response.res = res; 可以知道这里的res实际就是node.js原生的res
    res.statusCode = 404; // 返回状态码默认为404
    const onerror = err => ctx.onerror(err); // 处理错误的回调函数
    const handleResponse = () => respond(ctx); // 处理服务器响应的回调函数
    onFinished(res, onerror); // 执行回调 当http request 关闭结束或者有错误的时候
    return fnMiddleware(ctx).then(handleResponse).catch(onerror);
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */

  createContext(req, res) {
    // context对象
    const context = Object.create(this.context);
    // context对象添加一个request属性 指向request对象
    const request = context.request = Object.create(this.request);
    // context对象添加一个response属性 指向response对象
    const response = context.response = Object.create(this.response);
    // context request response 三者均添加一个 app 属性，指向这个 koa 实例
    context.app = request.app = response.app = this;
    // req 是原生 node 的请求对象 这里context request response 三者都添加了一个req属性 指向 req对象
    context.req = request.req = response.req = req;
    // res 是原生 node 的响应对象 这里context request response 三者都添加了一个res属性 指向 res对象
    context.res = request.res = response.res = res;
    // request 和 response对象上都添加一个 ctx 属性，指向context对象
    request.ctx = response.ctx = context;
    // request对象和response对象 互相作为对方的属性
    request.response = response;
    response.request = request;
    // context request 对象都添加一个originalUrl属性 指向原生req对象的url属性
    context.originalUrl = request.originalUrl = req.url;
    // context对象增加state 属性，用于保存一次请求中所需要的其他信息
    context.state = {};
    // 返回 context对象
    return context;
    // 到这里 大致能看出来作者的设计思路 context对象主要有四个属属性
    // context.req：原生的req对象
    // context.res：原生的res对象
    // context.request：koa自己封装的request对象
    // context.response：koa自己封装的response对象
    // 其中koa自己封装的和原生的最大的区别在于：koa自己封装的请求和响应对象的内容 不仅囊括原生的 还有一些其独有的东西
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    if (!(err instanceof Error)) throw new TypeError(util.format('non-error thrown: %j', err));

    if (404 == err.status || err.expose) return;
    if (this.silent) return;

    // onerror 函数只是仅仅输出 error.stack 作为错误信息。
    const msg = err.stack || err.toString();
    console.error();
    console.error(msg.replace(/^/gm, '  '));
    console.error();
  }
};

/**
 * Response helper.
 */
// respond 函数的作用就是：根据传入的 ctx 对象的 body ，method 属性来决定对 request 处理的方式以及如何 response
// 在 respond 函数中, 主要是运用 node http 模块中的响应对象中 res 的 end 方法与 koa中 ctx 对象中代理的属性进行最终响应对象的设置.
function respond(ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  if (!ctx.writable) return; // writable 是原生的 res 对象的 writeable 属性, 检查是否是可写流

  const res = ctx.res; // 实际还是node.js的res对象
  let body = ctx.body; // 响应主体
  const code = ctx.status; // 响应状态码

  // ignore body
  if (statuses.empty[code]) { // 如果响应的 statusCode 是属于 body 为空的类型, 例如 204, 205, 304, 将 body 置为 null
    // strip headers
    ctx.body = null;
    return res.end();
  }

  // 如果是 HTTP 的 HEAD 方法
  if ('HEAD' === ctx.method) {
    // headersSent是原生的 res 对象上的属性, 用于检查 http 响应头部是否已经被发送
    // 如果头部未被发送, 那么添加 length
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response;
      if (Number.isInteger(length)) ctx.length = length;
    }
    return res.end();
  }

  // status body
  // 如果 body 值为空
  if (null == body) {
    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code);
    } else {
      body = ctx.message || String(code); // body 值为 ctx 中的 message 属性或 code
    }
    // 如果头部未被发送, 那么添加 type length
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }
    return res.end(body);
  }

  // responses
  // 对 body 为 buffer 类型的进行处理
  if (Buffer.isBuffer(body)) return res.end(body);
  // 对 body 为字符串类型的进行处理
  if ('string' == typeof body) return res.end(body);
  // 对 body 为流形式的进行处理 body作为stream流写入res对象
  if (body instanceof Stream) return body.pipe(res);

  // body: json
   // 对 body 为 json 格式的数据进行处理
  body = JSON.stringify(body); // 1: 将 body 转化为 json 字符串
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body); // 2: 添加 length 头部信息
  }
  res.end(body);
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */
module.exports.HttpError = HttpError;
