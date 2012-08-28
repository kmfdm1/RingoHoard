var {Integer, Long, System} = java.lang;

export("CacheableResponse");

var CacheableResponse = function (cacheValue) {
    var data = cacheValue;
    if (!data) {
        data = new java.lang.Object[4];
    }
};


CacheableResponse.prototype.isExpired = function() {
    if (!data[0]) {
        return true;
    }
    return System.currentTimeMillis() > data[0].longValue();
};

CacheableResponse.prototype.touch = function(ttl) {
    if (ttl && ttl instanceof Number && ttl > 0) {
        data[0] = new Long(System.currentTimeMillis() + ttl);
        return;
    }
    data[0] = new Long(System.currentTimeMillis() + 10000);
};

CacheableResponse.prototype.setStatus = function() {
    data[1] = new Integer(status);
};

CacheableResponse.prototype.getStatus = function() {
    return data[1].intValue();
};

CacheableResponse.prototype.setHeaders = function(headers) {
    data[2] = headers.toJSON();
};

CacheableResponse.prototype.getHeaders = function() {
    if (!data[2]) {
        return null;
    }
    return data[2].parseJSON();
};

CacheableResponse.prototype.setPlainBody = function(body) {
    data[3] = body;
};

CacheableResponse.prototype.getPlainBody = function(body) {
    return data[3];
};

CacheableResponse.prototype.setGzipedBody = function(body) {
    data[4] = body;
};

CacheableResponse.prototype.getGzipedBody = function(body) {
    return data[4];
};

CacheableResponse.prototype.getData = function() {
    return data;
};