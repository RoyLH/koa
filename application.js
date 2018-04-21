
'use strict';

// application.js 包含 koa应用程序 的构造以及启动一个服务器 koa主要的逻辑处理代码 整个koa的处理

/**
 * Module dependencies.
 */
// 判断是不是generator function
const isGeneratorFunction = require('is-generator-function');
// 设置debug 的`namespace`
const debug = require('debug')('koa:application');
// 执行回调当http request关闭结束或者有错误的时候
const onFinished = require('on-finished');
// 引入response
const response = require('./response');
// 重头戏 koa-compose
const compose = require('koa-compose');
// 判断body是否应该为JSON 注: string 假值或者为stream或者buffer的时候返回false
const isJSON = require('koa-is-json');
const context = require('./context');
const request = require('./request');
// 下面只用了empty方法
// statuses是一个对象 empty属性
// status.empty = {
//   204: true,
//   205: true,
//   304: true
// }
const statuses = require('statuses');
// 获取设置http(s)cookie的模块
const Cookies = require('cookies');
// http accepts
// Accept 请求头用来告知客户端可以处理的内容类型，这种内容类型用MIME类型来表示
const accepts = require('accepts');
// node.js 事件机制
const Emitter = require('events');
// node.js 断言库
const assert = require('assert');
// stream模块
const Stream = require('stream');
// http模块
const http = require('http');
// 返回对象的指定键值
const only = require('only');
// 将基于koa生成器的中间件转换为基于promise的中间件
const convert = require('koa-convert');
// 给出一些信息(表示已经弃用)
const deprecate = require('depd')('koa');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */
// const app = new Koa() 很明显 Koa 是一个构造函数/es6中的class(类)
// Application 类继承了 nodejs 的 Events 类，从而可以监听以及触发事件
module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  constructor() {
    super();

    this.proxy = false;
    this.middleware = [];
    this.subdomainOffset = 2;
    this.env = process.env.NODE_ENV || 'development';
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);
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
    // 根据我们基础知识, this.callback() 执行的结果肯定是一个函数(http.createServer 方法所需要的回调函数), 这个函数无非就是根据 req 获取信息，同时向 res 中写入数据而已。
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

  toJSON() {
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

  inspect() {
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
    // 在 koa3 中，将默认不支持 generator 函数作为中间件
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
      fn = convert(fn);
    }
    debug('use %s', fn._name || fn.name || '-');
    this.middleware.push(fn); // 将该中间件函数存入middleware数组
    return this; // 返回koa的实例对象
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback() {
    const fn = compose(this.middleware); // 通过 koa-compose 模块将所有的中间件合并成一个中间件函数

    if (!this.listeners('error').length) this.on('error', this.onerror);

    const handleRequest = (req, res) => {  // 可以看到，callback 方法返回的 handleRequest 函数就是 http.createServer 方法所需要的回调函数
      const ctx = this.createContext(req, res); // 根据node.js原生的req, res对象生成一个ctx对象(也就是常说的上下文对象) 供中间件函数 fn 调用
      return this.handleRequest(ctx, fn); // handleRequest 函数内完成了对请求的处理以及对响应结果的返回 当有请求过来时，需要基于办好了request和response信息的ctx和所有中间件函数，来处理请求
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
    const onerror = err => ctx.onerror(err); // onerror 回调函数
    const handleResponse = () => respond(ctx); // 处理服务器响应的回调函数
    onFinished(res, onerror);
    // 中间件调用后 监听一个 error 事件，onerror 作为默认的错误处理函数。 若是没有error 使用handleResponse完成对请求的处理以及对响应结果的返回
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
    // context request 和 response 三者均添加一个 app 属性，指向这个 koa 实例
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
    // context， request 对象都添加一个originalUrl属性 指向原生req对象的url属性
    context.originalUrl = request.originalUrl = req.url;
    // context对象上添加cookies属性(根据koa实例对象提供的keys属性 和 request对象提供的secure属性)
    context.cookies = new Cookies(req, res, {
      keys: this.keys,
      secure: request.secure
    });
    // request 对象上创建 ip 属性 (通过secure 或者 req.socket.remoteAddress获取 ip的值 若无则为'')
    request.ip = request.ips[0] || req.socket.remoteAddress || '';
    // context, request对象增加accept 属性，该属性是个方法，用于判断 Content-Type
    context.accept = request.accept = accepts(req);
    // context独享增加state 属性，用于保存一次请求中所需要的其他信息
    context.state = {};

    return context; // 返回 context对象
    // 到这里 大致能看出来作者的设计思路 context对象主要有四个属属性
    // context.req：原生的req对象
    // context.res：原生的res对象
    // context.request：koa自己封装的request对象
    // context.response：koa自己封装的response对象
    // 其中koa自己封装的和原生的最大的区别在于，koa自己封装的请求和响应对象的内容 不仅囊括原生的 还有一些其独有的东西
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    assert(err instanceof Error, `non-error thrown: ${err}`);

    if (404 == err.status || err.expose) return;
    if (this.silent) return;

    const msg = err.stack || err.toString(); // onerror 函数只是仅仅输出 error.stack 作为错误信息。
    console.error();
    console.error(msg.replace(/^/gm, '  '));
    console.error();
  }
};

/**
 * Response helper.
 */
// respond 函数的作用就是，根据传入的 ctx 对象的 body ，method 属性来决定对 request 处理的方式以及如何 response
// 在 respond 函数中, 主要是运用 node http 模块中的响应对象中 res 的 end 方法与 koa ctx 对象中代理的属性进行最终响应对象的设置.
function respond(ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  const res = ctx.res; // 实际还是node.js的res对象
  if (!ctx.writable) return; // writable 是原生的 res 对象的 writeable 属性, 检查是否是可写流

  let body = ctx.body; // 响应主体
  const code = ctx.status; // 响应状态码

  // ignore body
  if (statuses.empty[code]) { // 如果响应的 statusCode 是属于 body 为空的类型, 例如 204, 205, 304, 将 body 置为 null
    // strip headers
    ctx.body = null;
    return res.end();
  }
  // 如果是 HTTP 的 HEAD 方法
  if ('HEAD' == ctx.method) {
    // headersSent 属性 Node 原生的 res 对象上的, 用于检查 http 响应头部是否已经被发送
    // 如果头部未被发送, 那么添加 length 头部
    if (!res.headersSent && isJSON(body)) {
      ctx.length = Buffer.byteLength(JSON.stringify(body));
    }
    return res.end();
  }

  // status body
  // 如果 body 值为空
  if (null == body) {
    body = ctx.message || String(code); // body 值为 ctx 中的 message 属性或 code
    // 修改头部的 type 与 length 属性
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
  body = JSON.stringify(body);  // 1: 将 body 转化为 json 字符串
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body); // 2: 添加 length 头部信息
  }
  res.end(body);
}