'use strict';

var shimmer = require('../../util/shimmer.js')
  , urltils = require('../../util/urltils.js')
  , logger  = require('../../util/logger.js').child('parsers.wrappers.hapi')
  , record  = require('../../metrics/recorders/generic.js')
  ;

function nameFromRequest(segment, request) {
  if (!segment) return logger.error("No TingYun context to set Hapi route name on.");
  if (!request) return logger.verbose("No Hapi request to use for naming.");
  var action = segment.trace.action;
  var path   = request.route && request.route.path;

  if (!path) return logger.verbose({request : request}, "No path found on Hapi route.");

  urltils.copyParameters(action.agent.config, request.params, segment.parameters);
  var action_id = action.verb + " " + path;
    action.setPartialName('Hapi/' + action_id.replace(/\//g, "%2F"));
}

function setDispatcher(agent) {
  agent.environment.setDispatcher('hapi');
  agent.environment.setFramework('hapi');
}

module.exports = function initialize(agent, hapi) {
  var tracer = agent.tracer;

  function wrapRender(render) {
    return function wrappedRender(filename, context, options, callback) {
      if ( ! agent.config.enabled ) return render.apply(this, arguments);
      var wrapped = callback;
      var segment = tracer.getSegment();
      if (segment && callback) {
        wrapped = tracer.callbackProxy(function cb_callbackProxy() {
          segment.end();
          return callback.apply(this, arguments);
        });
      }
      return render.call(this, filename, context, options, wrapped);
    };
  }

  function wrapReplyView(reply) {
    var view = reply.view;
    reply.view = function (template) {
      if ( ! agent.config.enabled ) return view.apply(this, arguments);
      if (tracer.getAction()) {

        var name = 'View/' + template + '/Rendering';
        var metricName = "HAPI/View::Render/" + template.replace(/\//g, "%2F");
        var segment_info = {
          metric_name : metricName,
          call_url: "",
          call_count: 1,
          class_name: "View",
          method_name: "Render",
          params : {}
        };

        tracer.addSegment(segment_info, record);
      }

      return view.apply(this, arguments);
    };
  }

  function wrapHandler(handler) {
    return function cls_wrapHandler(request, reply) {
      if ( ! agent.config.enabled ) return handler.apply(this, arguments);
      if (!tracer.getAction()) {
        logger.debug("Hapi route handler called outside action.");
        return handler.apply(this, arguments);
      }

      nameFromRequest(tracer.getSegment(), request);
      if (reply && reply.view) wrapReplyView(reply);

      return handler.apply(this, arguments);
    };
  }

  function tableVisitor(before, after, vhost, visit) {
    if (!vhost) vhost = '*';

    if (after) {
      Object.keys(after).forEach(function cb_forEach(method) {
        var beforeHandlers = before && before[method];
        var afterHandlers = after[method];
        if (afterHandlers.routes) afterHandlers = afterHandlers.routes;
        for (var i = 0; i < afterHandlers.length; i++) {
          var route = afterHandlers[i];
          if (!beforeHandlers || beforeHandlers.indexOf(route) === -1) {
            if(route.route) route = route.route;
            if(route.settings && route.settings.handler) route.settings.handler = visit(route.settings.handler);
          }
        }
      });
    }
  }

  function wrapRoute(_route) {
    return function wrappedRoute(configs, env) {
      var server = this;
      var router = server._router;
      if (!router) return logger.warning("no router found on hapi server");

      var vhosts = router.vhosts;
      var beforeHosts = {};
      if (vhosts) {
        logger.verbose("capturing vhosts on hapi router");
          for ( var host in vhosts ) {
              var the_host = beforeHosts[host] = {};
              var host_ref = vhosts[host];
              for ( var method in host_ref ) {
            the_host[method] = host_ref[method].slice();
              }
          }
      }
        // hapi 2: router.table -> router.routes & router.table is a function
        // hapi 1: when vhosts aren't used, router.table contains the routes
      var symbol = (typeof router.table === 'function')?'routes':'table';
      var table = router[symbol];
      var beforeTable = {};
      if (table) {
        Object.keys(table).forEach(function cb_forEach(method) {
          if (Array.isArray(table[method])) {
            beforeTable[method] = table[method].slice();
          } else {
            beforeTable[method] =table[method].routes || [];
          }
        });
      }

      var returned = _route.call(this, configs, env);

      vhosts = router.vhosts;
      if (vhosts) {
        Object.keys(vhosts).forEach(function cb_forEach(host) {
          tableVisitor(beforeHosts[host], vhosts[host], host, wrapHandler);
        });
      }

      table = router[symbol];
      if (table) tableVisitor(beforeTable, table, undefined, wrapHandler);

      return returned;
    };
  }
  function shimServerPrototype(proto, name) {
    shimmer.wrapMethod(proto, name, 'start',  function wp(start) {
      return function start_wrapper() {
        setDispatcher(agent);
        if (this._views) shimmer.wrapMethod(this._views.constructor.prototype, 'hapi.Views.prototype', 'render', wrapRender);
        return start.apply(this, arguments);
      };
    });
    shimmer.wrapMethod(proto, name, 'views', function wp(views) {
      return function Views_wrapper() {
        var result = views.apply(this, arguments);
        if (this._views) shimmer.wrapMethod(this._views.constructor.prototype, 'hapi.Views.prototype', 'render', wrapRender);
        return result;
      };
    });
    shimmer.wrapMethod(proto, name, '_route', wrapRoute);
  }
  function wrapCreateServer(createServer) {
    return function createServerWrapper() {
      var server = createServer.apply(this, arguments);
      shimServerPrototype(server.constructor.prototype, 'hapi.Server.constructor.prototype');
      shimmer.unwrapMethod(hapi, 'hapi', 'createServer');
      return server;
    };
  }
  function wrapResponse(response) {
    return function wrappedResponse() {
      if ( ! agent.config.enabled ) return response.apply(this, arguments);
      var segment = agent.tracer.getSegment();
      if (segment) segment.touch();
      return response.apply(this, arguments);
    };
  }
  function wrapInterface(replier) {
    return function wrappedInterface() {
      var reply = replier.apply(this, arguments);
      shimmer.wrapMethod(reply,'hapi.Reply','response', wrapResponse );
      return reply;
    };
  }

  function wrapConnection(connection) {
    return function wrappedConnection() {
      setDispatcher(agent);
      var plugin = connection.apply(this, arguments);
      if (plugin && plugin.connections && plugin.connections.length > 0) {
        shimmer.wrapMethod(plugin.connections[0].constructor.prototype,'hapi.Connection.constructor.prototype', '_route', wrapRoute);
        shimmer.wrapMethod(plugin.connections[0].server._replier.constructor.prototype,'hapi.Connection.server._replier.constructor.prototype','interface', wrapInterface);
        shimmer.unwrapMethod( hapi.Server.prototype, 'hapi.Server.prototype', 'connection' );
      }
      return plugin;
    };
  }
  var proto = hapi && hapi.Server && hapi.Server.prototype;
  if (proto && proto.start && proto.views && proto._route) {
    shimServerPrototype(proto, 'hapi.Server.prototype');
  }
  // Hapi 7.2 - 7.5.2
  else if (proto && Object.keys(proto).length === 0) {
    shimmer.wrapMethod(hapi, 'hapi', 'createServer', wrapCreateServer);
  }
  // Hapi 8+
  else if (proto && proto.start && proto.route && proto.connection) {
    shimmer.wrapMethod(proto, 'hapi.Server.prototype', 'connection', wrapConnection);
  }
  else {
    logger.warning('hapi Server constructor not found; can\'t instrument');
  }
};