
var {BlockingCache} = net.sf.ehcache.constructs.blocking;
var {CacheManager} = net.sf.ehcache;
var {Element} = net.sf.ehcache.Element;
var {ResponseFilter, Headers} = require('ringo/utils/http');

var cacheManager = module.singleton("HoardCacheManager", function() {
   return new CacheManager();
});

var cache =  module.singleton("HoardCache", function() {
    return new BlockingCache(cacheManager.getEhcache("hoard"));
});

exports.middleware = function hoardcache(next, app) {

    // comunication between app and this middleware
    app.hoardConfig = {
        'enabled': true,
        'defaultTTL': 10,
        'contentTypes': /^text|xml|json|javascript/
    };

    // construct the key for the cache-element-lookup
    var constructKey = function (request) {
        return request.scriptName + request.pathInfo + "?" + request.queryString;
    };
    
    // check if the given CacheableResponse is expired
    var isExpired = function(cr) {
        return new Date().getTime() > cr.validUntil;
    };
    
    // check if the request and response allow a gziped delivery
    var useGzip = function(request, cr) {
        return cr.status == 200 &&
               !cr.headers.content-encoding &&
               request.headers.accept-encoding.indexOf("gzip") > -1 &&
               cr.headers.content-type.match(app.hoardConfig.contentTypes);
    };

    // return the ttl determined by the requested resource
    var getTTLforRequest = function(request, response) {
       return app.hoardConfig.defaultTTL; // FIXME: make it a lookup
    };
    
    // return the ttl determined by the statuscode of the response
    var getTTLforStatusCode = function(status) {
       return app.hoardConfig.defaultTTL; // FIXME: make it a lookup
    };
    
    // check if we can deliver gziped and return the response-object according to this findings
    var serviceCacheElement = function (request, cr) {
        if (useGzip(request, cr)) {
            return {
                "status": 200,
                "headers": cr.headers,
                "body": cr.gziped.body
            };
        }
        return {
            "status": cr.status,
            "headers": cr.headers,
            "body": cr.plain.body
        };
    }

    /**
     * We have a cache miss
     */
    var serviceCacheMiss = function(request, key) {
        try {
            var ce;
            var response;
            var ttl = getTTLforRequest(request);
            
            // request is cacheable
            if (ttl > 0) {
                response = blockingService(request), headers = Headers(response.headers);
                // everything below 200 and above 399 - except 404 - will not be cached.
                if (response.status != 404 && (response.status < 200 || response.status >= 400)) {
                    return response;
                }
                var ttl = getTTLforStatusCode(response.status);
                
                // response is cacheable
                if (ttl > 0) {
                    headers.set("X-Cache", "MISS from " + request.host);
                    // FIXME: request.host .. should be something like the real hostname
                    var cr = createCacheableResponse(response);
                    ce = new Element(key, cr);
                    response = serviceCacheElement(request, cr);
                } else {
                    // response uncachable
                    ce = new Element(key, null);
                }
            } else {
                response = blockingService(request), headers = Headers(response.headers);
                headers.set("X-Cache", "NO Cache from " + request.host);
                ce = new Element(key, null);
            }
            cache.put(ce);
            return response;
        } catch (e) {
            cache.put(new Element(key, null));
        }
        return;
    };

    return function hoardcache(request) {
        // we are not a GET-Request? pass through
        // we are not enabled? pass through
        if (!app.hoardConfig.enabled || request.methos != "GET") {
            return next(request);
        }

        if (false) {
            // FIXME: management-url-check and service managerequests
        } else {
            var key = constructKey(request);
            var element;
            try {
                element = cache.get(key);
            } catch (e) {
                // FIXME: check if it is a LockTimeoutException
                return {
                    'status': 302,
                    'headers': {
                        'location': 'http://www.orf.at/locktimeout' // FIXME: configurable
                    }
                }
            }
            if (!element || element.getValue() == null) {
                return serviceCacheMiss(request, key);
            } else {
                var cr = element.getObjectValue().parseJSON();
                // FIXME: synchronize.. how?
                if (isExpired(cr) {
                    cr.touch();
                    return serviceCacheMiss(request, response, key);
                } else {
                    return serviceCacheElement(request, cr);
                }
            }
            
        }
    };
};

