### v1.6.0 (2017-12-15):
[优化功能]

  1. 错误重构
  
[修复bug]

  1. 探针内部运行时异常
  2. util.format bug导致上传数据格式错误问题. @see https://github.com/nodejs/node/issues/14896
  3. 修正pg模块数据库厂商名称
  4. 混合嵌码cookie丢失问题

### v1.5.4 (2017-09-25):
[修复bug]

  1. 修正跨应用数据丢失

### v1.5.3 (2017-09-20):
[新增功能]

  1.新增参数命名事务和参数命名外部应用功能 

[优化功能]

  1. 删除mysql模块查询执行计划前的正则匹配，提升性能

[修复bug]

  1. 修正某些特殊情况下的内存泄露问题

### v1.5.2 (2017-08-21):
[新增功能]

  1. 支持`unhandledRejection`事件，监控Promise异常，避免某些特殊情况下内存泄露
  2. 新增采样率功能
  3. 不兼容`node-postgres` v7.0.0+版本

[优化功能]

  1. 重构koa模块，删除加载模块时对koa-view的检测逻辑
  2. 优化混合嵌码逻辑
  3. 重构mysql模块，增加堆栈阈值和sql trace阈值开关
  4. 优化堆栈信息采集方式
  5. 优化外部请求监控过程

[修复bug]

  1. 修复rabbmitmq、activemq服务端性能采集开关无效bug
  2. 修复部分严谨模式下的异常 

### v1.5.1 (2017-06-24):
* 优化混合嵌码方式，提升探针运行稳定性
* 修改跨应用数据协议
* 修复MQ的流量指标上传协议格式错误
* 修正thrift组件的性能指标名称

### v1.5.0 (2017-04-16):
* 新增MQ相关模块性能数据采集，包括amqplib(RabbitMQ), kafka-node(Kafka), stompit(ActiveMQ)

### v1.4.1 (2017-02-10):
* 新增数据组件实例识别功能
* 新增应用过程响应时间的分位值计算

### v1.4.0 (2016-11-28):
* 添加api接口：noticeError（提交错误）、setWebActionName（自定义应用过程名称）
* 支持mysqld2模块
* 支持thinkjs web框架(v2.0.0+)
* 修正在同时开启执行计划分析和慢SQL查询跟踪时，sql trace采集不到的问题
* 修正mysql&&mysql2模块同时执行多个sql语句时，执行计划解析异常的问题
* 修正mysql模块采用connection.query(sql).on('result', callback)的调用方式，没有性能数据的问题

### v1.3.0 (2016-11-15):
* 重构KOA，添加对KOA2框架的支持
* 优化获取应用的依赖模块功能
* 新增tingyun.js配置文件（优先级高于tingyun.json）
* fixed getRedirectHost容错处理
* 支持node-redis v2.6.0+
* 添加thrift跨应用开关设置
* 增加自动嵌码规则，当请求为Ajax请求时不嵌码

### v1.2.0 (2016-09-20):
* WebAction命名
* 修正Metric数据类型
* 修正Metric Id 序列化
* 兼容bluebird v3.0+
* 更新依赖包async-listener(^0.6.0)版本
* 修正MySql模块connection.query()参数处理逻辑
* 修正外部错误计数
* 更新日志输出格式

### v1.1.12 (2016-08-15):
* 修改浏览器嵌码方式，增加混合嵌码

### v1.1.11 (2016-08-10):
* 修正ioredis访问访问后调用栈丢失问题
* 修正express中间件丢失问题,修正log输出内容
* 修正pgsql bug

### v1.1.10 (2016-07-21):
* 修正ioredis访问阻塞

### v1.1.9 (2016-06-01):
* 修正错误数据，增加外部错误信息
* 修改js嵌码位置
* 优化配置文件
* 修改跨应用追踪数据，时间字段数据类型（浮点型->整型）
* 修正当action异常时KOA的路由信息
* 简化sql混淆方法
* 在actionTrace中添加混淆sql和stacktrace数据

### v1.1.8 (2016-05-11):
* 增加thrift跨应用追踪
* 修正错误数据上传内容，错误代码数据类型为整型
* koa框架url聚合

### v1.1.7 (2016-04-18):
* fix bug:ActionTrace上传数据问题
* fix bug:添加错误率数据
* fix bug:thrift数据上传结构
* 支持KOA1框架

### v1.1.6 (2016-04-12):
* 修改redis数据接口格式

### v1.1.5 (2016-04-01):
* 添加对`ioredis`模块的支持

### v1.1.4 (2015-11-13):
* 添加对Oracle社区模块`node-oracle`的支持
* 修改跨应用追踪(2016-01-28)
* 修正hapi框架bug

### v1.1.3 (2015-10-22):
* 添加浏览器嵌码功能

### v1.1.2 (2015-10-20):
* 添加对Oracle官方Nodejs模块oracledb的支持

### v1.1.1 (2015-10-15):
* 修复"最新版Nodejs版本号引起的系统不能正常启动问题" 的bug

### v1.1.0 (2015-08-03):
* 修复"找不到TingYun 对象" 的bug
* 支持跨应用追踪
### v1.0.1 (2015-06-30):
* 移除tingyun.js,增加setup.js, 简化安装过程: npm install 之后运行配置向导: node ./node_modules/tingyun/setup.js,生成tingyun.json配置文件
* 支持windows版本
* thrift 增加对0.9.2多service支持。
* 修复报表中慢应用过程追踪性能数据出现负值的bug
### v1.0.0 (2015-05-27):


* 1.0.0版本发布.
* 支持列表
      web       : http模块
      Framework : express, hapi, restify
      sql       : pg, mysql
      no_sql    : mongodb, redis, memcached, node-cassandra-cql
      External  : http, thrift
* 功能
      1、web性能数据采集
      2、Error Trace信息采集
      3、慢过程追踪信息采集
      4、慢sql追踪信息采集