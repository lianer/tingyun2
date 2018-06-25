1,安装：
-------------------------------------------------
		进入应用根目录并执行安装
		cd <app root dir> 
		npm install tingyun
		or
		npm install http://download.tingyun.com/agent/nodejs/latest/tingyun-agent-nodejs-latest.tar.gz 

2,配置：
-------------------------------------------------
### 1)、执行配置命令，填写应用名和授权序号
		node node_modules/tingyun/setup.js 
### 2)、修改应用的主文件,将 require('tingyun') 添加到文件首行。
		如果您的package.json中没有设置main参数，并且应用根路径下没有index.js文件，那么需要手动将"require('tingyun')" 添加到主文件的首行。 
		配置完成之后会在应用目录下生成 tingyun.json文件.
3,配置项含义：
-------------------------------------------------

###3.1启用/禁用性能信息采集
		配置选项格式:
		   "enabled" : true
		   type    : boolean
		   value   : true/false
		   default : true
		说明
		  允许或者禁止NodeJS探针采集数据。本选项设置为false时，NodeJS探针将不再采集性能数据。只有当本选项设置为true时，才会有性能数据被采集。
###3.2授权序号
		配置选项格式:
		   "licenseKey" : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 
		   type    : string
		   value   : 字符串
		   default : 无
		说明
		  本条配置项是您在安装时输入的授权序号。
###3.3应用名
		配置选项格式:
		   "app_name" : ["Node"], 
		   type    : string
		   value   : 字符串
		   default : 无
		说明
		  应用识别名称
###3.4日志管理
		NodeJS探针有两个模块:守护进程和NodeJS扩展。每个模块都有单独的日志管理
###  3.4.1日志文件路径 
		配置选项格式:
		   agent_log_file_name : "/var/log/networkbench/tingyun_agent.log", 
		   type    : string
		   value   : 字符串
		   default : <app root>/tingyun_agent.log
		说明:
		  指定NodeJS的日志文件路径。
###  3.4.2日志级别 
		配置选项格式:
		   agent_log_level : "info", 
		   type            : string
		   value           : debug" > "verbose" > "info" > "warning" > "error" > "critical"
		   default         : "info"
		说明:
		  本选项是控制日志数据写入日志文件的级别。"debug"是最低级，允许所有日志信息写入日志文件。"critical"是最高级,仅有critical级别日志允许写入
###3.5审计模式
		配置选项格式:
		   "audit_mode" : false
		   type         : boolean
		   value        : true/false
		   default      : false
		说明:
		  本选项设定是否在日志文件中写入更详尽的信息，包括所有的向听云后台上传和下载的数据。
###3.6数据发送连接选项
###  3.6.1是否启用http安全连接 
		配置选项格式:
		   "ssl"   : true
		   type    : boolean
		   value   : true/false
		   default : true
		说明:
		  本选项指定向服务器发送数据是否弃用 安全连接(https)。若设定为true，则向服务器发送数据时期用https方式。否则，使用普通http方式。
###  3.6.2代理服务器地址 
		配置选项格式:
		   "proxy_host" : '' 
		   type         : string
		   value        : http代理服务器地址
		   default      : ''
		说明:
		  本选项指定代理服务器的地址。若选项不为空，并且未启用安全连接，则本选项值为http代理服务器的ip地址。
###  3.6.3代理服务器端口 
		配置选项格式:
		   "proxy_port" : ''
		   type         : digit
		   value        : 
		   default      : 无
		说明:
		  同前，本选项指定代理服务器的端口。
###  3.6.4代理服务器user 
		配置选项格式:
		   "proxy_user" : ''
		   type         : string
		   value        : 
		   default      : 无
		说明:
		  同前，若代理服务器需要用户名密码，本选项指定代理服务器的登陆名。
###  3.6.5代理服务器password 
		配置选项格式:
		   "proxy_password" : ''
		   type             : string
		   value            : 
		   default          : 无
		说明:
		  同前，若代理服务器需要用户名密码，本选项指定代理服务器的登陆密码。

