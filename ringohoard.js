addToClasspath("./jars/ehcache-core-2.6.0.jar");
// addToClasspath("./jars/slf4j-api-1.6.1.jar");
//addToClasspath("./jars/slf4j-jdk14-1.6.1.jar");

var {ByteArrayOutputStream} = java.io;
var {ByteString} = require('binary');
var {GZIPOutputStream} = java.util.zip;
var {BlockingCache} = net.sf.ehcache.constructs.blocking;
var {CacheManager} = net.sf.ehcache;
var {Element, Cache} = net.sf.ehcache;
var {ResponseFilter, Headers} = require('ringo/utils/http');
var {CacheableResponse} = require('./cacheableresponse');
var log = require("ringo/logging").getLogger("ringohoard");

/**
 * get the singleton cacheManager
 */
var cacheManager = module.singleton("RingoHoardCacheManager", function() {
   return new CacheManager();
});

/**
 * get the singleton cache holding all cache-objects
 */
var cache =  module.singleton("RingoHoardCache", function() {
    var cache = cacheManager.getEhcache("hoard");
    if (!cache) {
        cache = new Cache("hoard", 10000, false, true, 0, 0);
        cacheManager.addCache(cache);
    }
    return new BlockingCache(cache);
});

exports.middleware = function ringohoard(next, app) {

    // communication between app and this middleware
    app.hoardConfig = {
        'enabled': true,
        'defaultTTL': 60,
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
            return new java.lang.Sring(app.hoardConfig.cacheKeyFactory(request));
        }
        return new java.lang.String(request.scriptName + request.pathInfo + "?" + request.queryString);
    };
    
    /**
     * check if the request and response allow a gziped delivery
     */
    var useGzip = function(request, cr) {
        var status = cr.getStatus();
        var headers = cr.getHeaders();
        return (status == 200 || status == 404) &&
               !headers["content-encoding"] &&
               app.hoardConfig.contentTypes.test(headers["content-type"]) &&
               (!request || request.headers["accept-encoding"].indexOf("gzip") > -1);
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
            if (skipHeaders.indexOf(i) > -1) {
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
       return app.hoardConfig.defaultTTL * 1000; // FIXME: make it a lookup
    };
    
    /** 
     * return the ttl determined by the statuscode of the response
     */
    var getTTLforStatusCode = function(status) {
       return app.hoardConfig.defaultTTL * 1000; // FIXME: make it a lookup
    };

    /**
     * create a new instance of cacheablersponse
     */
    var createCacheableResponse = function(response, ttl) {
        var cr = CacheableResponse.createFromResponse(response.status, filterHeaders(response.headers), response.body);
        cr.touch(ttl);
        if (useGzip(null, cr)) {
            cr.setGzipedBody(gzip("" + cr.getPlainBody()));
        }
        return cr;
    };
    
    /**
     * gzip the data given and return it as ByteString
     */
    var gzip = function(data) {
        log.info("gziping: " + data);
        var bytes = new ByteArrayOutputStream(),
            gzip = new GZIPOutputStream(bytes);
        if (!(data instanceof Binary)) {
            data = data.toByteString();
        }
        gzip.write(data);
        gzip.finish();
        var zipped = bytes.toByteArray();
        bytes.reset();
        return zipped;
    };

    /**
     * take the cacheable response and return either the plain response or the gziped
     * response ready to return to the next in the jsgi-chain
     */
    var serviceCacheElement = function (request, cr) {
        var headers = cr.getHeaders();
        headers['x-cache'] = 'HIT from '; // FIXME: add none-virtual real hostname
        if (useGzip(request, cr) && cr.hasGzipedBody()) {
            headers['content-encoding'] = 'gzip';
            return {
                "status": cr.getStatus(),
                "headers": headers,
                "body": cr.getGzipedBody()
            };
        }
        return {
            "status": cr.getStatus(),
            "headers": headers,
            "body": cr.getPlainBody()
        };
    };

    /**
     * We have a cache miss
     */
    var serviceCacheMiss = function(request, key) {
        var response = next(request);
        log.info("orig: " + response.toSource());
        try {
            var ce;
            var ttl = getTTLforRequest(request);
            
            // request is cacheable
            if (ttl > 0) {
                // everything below 200 and above 399 - except 404 - will not be cached.
                if (response.status != 404 && (response.status < 200 || response.status >= 400)) {
                    return response;
                }

                ttl = getTTLforStatusCode(response.status);
                // response is cacheable
                if (ttl > 0) {
                    // FIXME: request.host .. should be something like the real hostname
                    var cr = createCacheableResponse(response, ttl);
                    ce = new Element(key, cr.data);
                    response = serviceCacheElement(request, cr);
                    response.headers["x-cache"] = "MISS from " + request.host; // FIXME: use none-virtual real hostname
                } else {
                    // response uncachable
                    ce = new Element(key, null, true, 0, 0);
                }
            } else {
                // response is not cacheable
                response.headers.set("x-cache", "Uncached from " + request.host); // FIXME: use real, none-virtual hostname
                ce = new Element(key, null, true, 0, 0);
            }
            cache.put(ce);
            return response;
        } catch (e) {
            log.error("exception while servicing cache-miss: " + e);
            cache.put(new Element(key, null, true, 0, 0));
        }
    };

    var handle = function(request) {
        // we are not a GET-Request? pass through
        // we are not enabled? pass through
        if (!app.hoardConfig.enabled || request.method != "GET") {
            log.debug("no ringohoard: " + app.hoardConfig.enabled + "/" + request.method);
            return next(request);
        }

        if (false) {
            // FIXME: management-url-check and service managerequests
        } else {
            var key = constructKey(request);
            var element;
            try {
                log.info("key: " + key);
                element = cache.get(key);
            } catch (e) {
                // FIXME: check if it is a LockTimeoutException
                log.info("exception while cache.get(): " + e);
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
                log.info("Service cacheMiss (no element at all)");
                return serviceCacheMiss(request, key);
            } else {
                var cr, expired;
                sync(function () {
                    cr = new CacheableResponse(element.getObjectValue());
                    expired = cr.isExpired();
                    if (expired) {
                        // touch the cachableResponse
                        cr.touch();
                    }
                }, element)();
                log.info("after sync");
                if (expired) {
                    log.info("Service cacheMiss (element expired)");
                    return serviceCacheMiss(request, key);
                }
                log.info("Service cache hit");
                return serviceCacheElement(request, cr);
            }

        }
    };

    return function ringohoard(request) {
        var res = handle(request);
        log.info("after Cache: " + res.toSource());
        return res;
    };
};

