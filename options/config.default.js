
exports.config = {
  /**
   * 默认 app 名字,可多个
   * @env TINGYUN_APP_NAME
   */
  app_name : [],
  /**
   * 默认license
   * @env TINGYUN_LICENSE_KEY
   */
  licenseKey : '',
  /**
   * 入口服务器地址
   * @env TINGYUN_HOST
   */
  host : 'redirect.networkbench.com',
  /**
   * 入口服务器端口
   * @env TINGYUN_PORT
   */
//  port : 443,
  /**
   * 是否启用安全套接字
   * @env TINGYUN_USE_SSL
   */
  ssl : true,
  /**
   * 代理服务器url,与proxy_host等选项含义相同，另一种形式
   * @env TINGYUN_PROXY_URL
   */
  proxy: '',
  /**
   * 代理服务器地址
   * @env TINGYUN_PROXY_HOST
   */
  proxy_host : '',
  /**
   * 代理服务器端口
   * @env TINGYUN_PROXY_PORT
   */
  proxy_port : '',
  /**
   *  代理服务器用户名
   * @env TINGYUN_PROXY_USER
   */
  proxy_user : '',
  /**
   *  代理服务器密码
   * @env TINGYUN_PROXY_PASS
   */
  proxy_pass : '',
  /**
   * 是否启用听云探针
   * @env TINGYUN_ENABLED
   */
  enabled : true,
  /**
   * 默认的apcex_t值(满意响应时间)
   * @env TINGYUN_APDEX
   */
  apdex_t : 100,
  /**
   * Whether to capture parameters in the request URL in slow action
   * traces and error traces. Because this can pass sensitive data, it's
   * disabled by default. If there are specific parameters you want ignored,
   * use ignored_params.
   *
   * @env TINGYUN_CAPTURE_PARAMS
   */
  capture_params : false,
  /**
   * Array of parameters you don't want captured off request URLs in slow
   * action traces and error traces.
   *
   * @env TINGYUN_IGNORED_PARAMS
   */
  ignored_params : [],
  agent_log_level : 'info',
  agent_log_file_name : require('path').join(process.cwd(), 'tingyun_agent.log'),
  /**
   * Whether to collect & submit error traces to TingYun.
   *
   * @env TINGYUN_ERROR_COLLECTOR_ENABLED
   */
  error_collector : {
    /**
     * 是否发送错误日志
     */
    enabled : true,
    /**
     * 忽略的错误代码
     * Defaults to 404 NOT FOUND.
     *
     * @env TINGYUN_ERROR_COLLECTOR_IGNORE_ERROR_CODES
     */
    ignored_status_codes : [404]
  },
  transaction_tracer : {

  },

action_tracer : {
//      slow_sql : true,
    /**
     * action trace 开关
     * @env TINGYUN_TRACER_ENABLED
     */
    enabled : true,
    /**
     * action trace 时间 可接受阀值
     * @env TINGYUN_TRACER_THRESHOLD
     */
    action_threshold : 'apdex_f',
    /**
     * 最慢个数(慢过程追踪)
     * @env TINGYUN_TRACER_TOP_N
     */
    top_n : 20
  },

  debug : {
    /**
     * Whether to collect and submit internal supportability metrics alongside
     * application performance metrics.
     *
     * @env TINGYUN_DEBUG_METRICS
     */
    internal_metrics : false,
  },
  /**
   * Rules for naming or ignoring actions.
   */
  rules : {

    name : [],

    ignore : []
  },

  url_rules: [
    {
      "terminate_chain" : true,
      "replacement"     : "/*.\\1",
      "each_segment"    : false,
      "ignore"          : false,
      "match_expression": ".*\\.(ace|arj|ini|txt|udl|plist|css|gif|ico|jpe?g|js|png|swf|woff|caf|aiff|m4v|mpe?g|mp3|mp4|mov)$",
      "replace_all"     : false,
      "eval_order"      : 1000
    },
    {
      "terminate_chain" : false,
      "replacement"     : "*",
      "each_segment"    : true,
      "ignore"          : false,
      "match_expression": "^[0-9][0-9a-f_,.-]*$",
      "replace_all"     : false,
      "eval_order"      : 1001
    },
    {
      "terminate_chain" : false,
      "replacement"     : "\\1/.*\\2",
      "each_segment"    : false,
      "ignore"          : false,
      "match_expression": "^(.*)/[0-9][0-9a-f_,-]*\\.([0-9a-z][0-9a-z]*)$",
      "replace_all"     : false,
      "eval_order"      : 1002
    }
  ],
  /**
   * By default, any actions that are not affected by other bits of
   * naming logic (the API, rules, or metric normalization rules) will
   * have their names set to 'NormalizedUri/*'. Setting this value to
   * false will set them instead to Uri/path/to/resource. Don't change
   * this setting unless you understand the implications of TingYun's
   * metric grouping issues and are confident your application isn't going
   * to run afoul of them. Your application could end up getting blackholed!
   * Nobody wants that.
   *
   * @env TINGYUN_ENFORCE_BACKSTOP
   */
  enforce_backstop : true,
  rum : {},

  /**
   * Web action naming rules.
   */
  naming: {},

  /**
   * MQ configuration.
   */
  mq: {}
};
