addToClasspath("./jars/ehcache-core-2.4.7.jar");
addToClasspath("./jars/slf4j-api-1.6.1.jar");
addToClasspath("./jars/slf4j-jdk14-1.6.1.jar");

var {BlockingCache} = net.sf.ehcache.constructs.blocking;
var {CacheManager} = net.sf.ehcache;
var {Element} = net.sf.ehcache;
var {ResponseFilter, Headers} = require('ringo/utils/http');
var {CacheableResponse} = require('./cacheableresponse');

var cacheManager = module.singleton("RingoHoardCacheManager", function() {
   return new CacheManager();
});

var cache =  module.singleton("RingoHoardCache", function() {
    return new BlockingCache(cacheManager.getEhcache("hoard"));
});

exports.middleware = function ringohoard(next, app) {

    // communication between app and this middleware
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
        var cr = new CachableResponse();
        cr.touch(ttl);
        var headers = filterHeaders(response.headers);
        headers['x-cache'] = 'HIT from '; // FIXME: server
        cr.setHeaders(headers);
        cr.setPlainBody(response.body);
        if (useGzip(null, response)) {
            cr.setGzipedBody(gzip(cr.plain));
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
     * take the cacheable response and return either the plain response or the gziped
     * response ready to return to the next in the jsgi-chain
     */
    var serviceCacheElement = function (request, cr) {
        if (useGzip(request, cr) && cr.gziped && cr.gziped.body) {
            var headers = cr.getHeaders();
            headers['content-encoding'] = 'gzip';
            headers[''] = '';
            return {
                "status": cr.getStatus(),
                "headers": headers,
                "body": new ResponseFilter(cr.getGzipedBody(), function(part) {
                    return part;
                })
            };
        }
        return {
            "status": cr.getStatus(),
            "headers": cr.getHeaders(),
            "body": new ResponseFilter(cr.getPlainBody(), function(part) {
                return part;
            })
        };
    };

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
                response = blockingService(request), headers = new Headers(response.headers);
                // everything below 200 and above 399 - except 404 - will not be cached.
                if (response.status != 404 && (response.status < 200 || response.status >= 400)) {
                    return response;
                }
                ttl = getTTLforStatusCode(response.status);
                
                // response is cacheable
                if (ttl > 0) {
                    headers.set("x-cache", "MISS from " + request.host);
                    // FIXME: request.host .. should be something like the real hostname
                    var cr = createCacheableResponse(response, ttl);
                    ce = new Element(key, cr.getData());
                    response = serviceCacheElement(request, cr);
                } else {
                    // response uncachable
                    ce = new Element(key, null);
                }
            } else {
                response = blockingService(request), headers = new Headers(response.headers);
                headers.set("x-cache", "NO Cache from " + request.host);
                ce = new Element(key, null);
            }
            cache.put(ce);
            return response;
        } catch (e) {
            cache.put(new Element(key, null));
        }
    };

    return function ringohoard(request) {
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
                // FIXME: look into it how other requests may wait for this to finish and use the same response for themselves
                return serviceCacheMiss(request, key);
            } else {
                var cr, expired;
                sync(function () {
                    cr = new CacheableRsponse(element.getObjectValue());
                    expired = cr.isExpired();
                    if (expired) {
                       // touch the cachableResou
                       cr.touch();
                    }
                }, element);
                if (expired) {
                    return serviceCacheMiss(request, key);
                }
                return serviceCacheElement(request, cr);
            }
            
        }
    };
};

