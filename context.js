
'use strict';

// 将response, request 上的方法挂载在这，生成ctx上下文对象

/**
 * Module dependencies.
 */

const util = require('util'); // node.js的util模块
const createError = require('http-errors'); // 用于throw方法 制造一个http错误(createError(401, 'Please login to view this page.'))
const httpAssert = require('http-assert'); // 用于断言处理,可以返回ctx.throw之类的给捕捉
const delegate = require('delegates'); // 用来委托方法 getter 与setter
const statuses = require('statuses');
// 下面只用了empty方法
// statuses是一个对象 empty属性
// status.empty = {
//   204: true,
//   205: true,
//   304: true
// }
const Cookies = require('cookies');

const COOKIES = Symbol('context#cookies');

/**
 * Context prototype.
 */

const proto = module.exports = {

  /**
   * util.inspect() implementation, which
   * just returns the JSON output.
   *
   * @return {Object}
   * @api public
   */

  inspect() {
    if (this === proto) return this;
    return this.toJSON();
  },

  /**
   * Return JSON representation.
   *
   * Here we explicitly invoke .toJSON() on each
   * object, as iteration will otherwise fail due
   * to the getters and cause utilities such as
   * clone() to fail.
   *
   * @return {Object}
   * @api public
   */

  toJSON() {
    return {
      request: this.request.toJSON(),
      response: this.response.toJSON(),
      app: this.app.toJSON(),
      originalUrl: this.originalUrl,
      req: '<original node req>',
      res: '<original node res>',
      socket: '<original node socket>'
    };
  },

  /**
   * Similar to .throw(), adds assertion.
   *
   *    this.assert(this.user, 401, 'Please login!');
   *
   * See: https://github.com/jshttp/http-assert
   *
   * @param {Mixed} test
   * @param {Number} status
   * @param {String} message
   * @api public
   */

  assert: httpAssert,

  /**
   * Throw an error with `status` (default 500) and
   * `msg`. Note that these are user-level
   * errors, and the message may be exposed to the client.
   *
   *    this.throw(403)
   *    this.throw(400, 'name required')
   *    this.throw('something exploded')
   *    this.throw(new Error('invalid'))
   *    this.throw(400, new Error('invalid'))
   *
   * See: https://github.com/jshttp/http-errors
   *
   * Note: `status` should only be passed as the first parameter.
   *
   * @param {String|Number|Error} err, msg or status
   * @param {String|Number|Error} [err, msg or status]
   * @param {Object} [props]
   * @api public
   */

  // throw方法 上面是使用的方法 我们常用来在中间件throw发出一些错误状态码。
  // 从而使得上级中间件可以try catch这个错误从而响应
  // createError([status], [message], [properties])
  // properties - custom properties to attach to the object
  throw(...args) {
    throw createError(...args);
  },

  /**
   * Default error handling.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    // don't do anything if there is no error.
    // this allows you to pass `this.onerror`
    // to node-style callbacks.
    if (null == err) return;

    // 如果error不是Error实例。此时生成一个错误实例给下文处理
    if (!(err instanceof Error)) err = new Error(util.format('non-error thrown: %j', err));

    let headerSent = false;
    if (this.headerSent || !this.writable) {
      headerSent = err.headerSent = true;
    }

    // delegate
    // 触发事件
    // 与application.js中的 if (!this.listenerCount('error')) this.on('error', this.onerror); 一句相呼应
    this.app.emit('error', err, this);

    // nothing we can do here other
    // than delegate to the app-level
    // handler and log.
    if (headerSent) {
      return;
    }

    // 解构一下获得node.js原生res对象
    const { res } = this;

    // 首次清除所有的headers
    // first unset all headers
    /* istanbul ignore else */
    if (typeof res.getHeaderNames === 'function') {
      res.getHeaderNames().forEach(name => res.removeHeader(name));
    } else {
      res._headers = {}; // Node < 7.7
    }

    // 然后设置为错误的headers标识
    // then set those specified
    this.set(err.headers);

    // 强制text/plain
    // force text/plain
    this.type = 'text';

    // 支持ENOENT ENOENT一般是没找到文件或路径,包括因为权限问题没找到的情况
    // ENOENT support
    if ('ENOENT' == err.code) err.status = 404;

    // 状态码不是数字 或者 不是 204 205 304中的任何一个 默认转换成500状态码
    // default to 500
    if ('number' != typeof err.status || !statuses[err.status]) err.status = 500;

    // 响应
    // respond
    const code = statuses[err.status];
    const msg = err.expose ? err.message : code;
    this.status = err.status;
    this.length = Buffer.byteLength(msg);
    res.end(msg);
    // 原生的方法
    // 给我们一个提示我们要使一个连接关闭 那么ctx.res.end(msg);
  },

  get cookies() {
    if (!this[COOKIES]) {
      this[COOKIES] = new Cookies(this.req, this.res, {
        keys: this.app.keys,
        secure: this.request.secure
      });
    }
    return this[COOKIES];
  },

  set cookies(_cookies) {
    this[COOKIES] = _cookies;
  }
};

/**
 * Custom inspection implementation for newer Node.js versions.
 *
 * @return {Object}
 * @api public
 */

/* istanbul ignore else */
if (util.inspect.custom) {
  module.exports[util.inspect.custom] = module.exports.inspect;
}

/**
 * Response delegation.
 */
// 委托到这个上下文 ctx 对象里
// 委托方法 与属性的getter或者setter
delegate(proto, 'response')
  .method('attachment') // 当我们访问 ctx.attachment 的时候 实际上访问的是 ctx.response.attachment
  .method('redirect')
  .method('remove')
  .method('vary')
  .method('has')
  .method('set')
  .method('append')
  .method('flushHeaders')
  .access('status')
  .access('message')
  .access('body')
  .access('length')
  .access('type')
  .access('lastModified')
  .access('etag')
  .getter('headerSent')
  .getter('writable');

/**
 * Request delegation.
 */

delegate(proto, 'request')
  .method('acceptsLanguages') // 当我们访问 ctx.acceptsLanguages 的时候 实际上访问的是 ctx.request.acceptsLanguages
  .method('acceptsEncodings')
  .method('acceptsCharsets')
  .method('accepts')
  .method('get')
  .method('is')
  .access('querystring')
  .access('idempotent')
  .access('socket')
  .access('search')
  .access('method')
  .access('query')
  .access('path')
  .access('url')
  .access('accept')
  .getter('origin')
  .getter('href')
  .getter('subdomains')
  .getter('protocol')
  .getter('host')
  .getter('hostname')
  .getter('URL')
  .getter('header')
  .getter('headers')
  .getter('secure')
  .getter('stale')
  .getter('fresh')
  .getter('ips')
  .getter('ip');
