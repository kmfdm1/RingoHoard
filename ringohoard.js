
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

    /**
     * construct the key for the cache-element-lookup
     * If app doesn't want to take control over cache-key-creation the default will be used
     * constructing cache-keys by concatination of
     * request.scriptName + request.pathInfo + "?" + request.queryString
     */
    var constructKey = function (request) {
        if (app.hoardConfig.cacheKeyFactory) {
            return app.hoardConfig.cacheKeyFactory(request);
        }
        return request.scriptName + request.pathInfo + "?" + request.queryString;
    };
    
    /**
     * check if the given CacheableResponse is expired
     */
    var isExpired = function(cr) {
        return new Date().getTime() > cr.validUntil;
    };
    
    /**
     * check if the request and response allow a gziped delivery
     */
    var useGzip = function(request, cr) {
        return cr.status == 200 &&
               !cr.headers.content-encoding &&
               cr.headers.content-type.match(app.hoardConfig.contentTypes) &&
               (!request || request.headers.accept-encoding.indexOf("gzip") > -1);
    };
    
    /**
     * filters the headers of the response and returns only those which can be used
     * for a response directly from cache
     */
    var filterHeaders = function(headers) {
        if (app.hoardConfig.headerFilter) {
            return headerFilter(headers);
        }
        // filter out cookies per default
        var skipHeaders = ["cookies"];
        var filtered = {};
        for (var i in headers) {
            if (skipHeaders.contains(i)) {
               continue;
            }
            filtered[i] = headers[i];
        }
        return filtered;
    };

    /**
     * return the ttl determined by the requested resource
     */ 
    var getTTLforRequest = function(request, response) {
       return app.hoardConfig.defaultTTL; // FIXME: make it a lookup
    };
    
    /** 
     * return the ttl determined by the statuscode of the response
     */
    var getTTLforStatusCode = function(status) {
       return app.hoardConfig.defaultTTL; // FIXME: make it a lookup
    };

    /**
     * create the basic structure of a cacheable response
     * validUntil: millis of expire-timestamp
     * headers: object containing all headers (except the "content-encoding: gziped" which has to be set if gziped content is used for delivery 
     * plain: the body of the plain response
     * gziped: the body of the gziped response
     */
    var createCacheableResponse = function(response, ttl) {
        var cr = {'validUntil': new Date(new Date().getTime() + ttl * 1000),
                 'headers': {},
                 'plain': {}};
        cr.headers = filterHeaders(response.headers);
        cr.plain = response.body;
        if (useGzip(null, response)) {
            cr.gziped = gzip(cr.plain);
        }
        return cr;
    };
    
    /**
     * gzip the data given and return it as ByteString
     */
    var gzip = function(data) {
        var bytes = new ByteArrayOutputStream(),
            gzip = new GZIPOutputStream(bytes);
        if (!(data instanceof Binary)) {
            data = data.toByteString();
        }
        gzip.write(data);
        if (bytes.size() > 1024) {
            var zipped = bytes.toByteArray();
            bytes.reset();
            return new ByteString(zipped);
        }
        return null;
    };

    /**
     * take the cacheableresponse and return either the plain response or the gziped
     * response ready to return to the next in the jsgi-chain
     */
    var serviceCacheElement = function (request, cr) {
        if (useGzip(request, cr) && cr.gziped && cr.gziped.body) {
            var headers = cr.headers;
            headers.content-encoding = 'gzip';
            return {
                "status": cr.status,
                "headers": headers,
                "body": new ResponseFilter(cr.gziped.body, function(part) {
                    return part;
                })
            };
        }
        return {
            "status": cr.status,
            "headers": cr.headers,
            "body": new ResponseFilter(cr.plain.body, function(part) {
                return part;
            })
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
                    var cr = createCacheableResponse(response, ttl);
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
                        'location': 'http://localhost/locktimeout' // FIXME: configurable
                    }
                }
            }
            if (!element || element.getValue() == null) {
                // no element in cache -> service cacheMiss
                // FIXME: look into it how other requests may wait for this to finish and use the same response for themselve
                return serviceCacheMiss(request, key);
            } else {
                var cr;
                sync(function () {
                    cr = unwrapCacheElement(element);
                    if (isExpired(cr)) {
                       // touch the cachableResou
                       cr.validUntil = new Date().getTime() + 10000;
                    }
                }, element);
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

