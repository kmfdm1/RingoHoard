var {Integer, Long, System} = java.lang;
var {ByteString} = require('binary');

export("CacheableResponse");

var CacheableResponse = function (cacheValue) {
    if (!cacheValue) {
        this.data = new java.lang.reflect.Array.newInstance(java.lang.Object, 5);
    } else {
        this.data = cacheValue;
    }
};

CacheableResponse.FIELD_TTL = 0;
CacheableResponse.FIELD_STATUS = 1;
CacheableResponse.FIELD_HEADERS = 2;
CacheableResponse.FIELD_PLAIN_BODY = 3;
CacheableResponse.FIELD_GZIPED_BODY = 4;


CacheableResponse.createFromResponse = function(status, headers, body) {
    var cr = new CacheableResponse();
    cr.setStatus(status);
    cr.setHeaders(headers);
    cr.setPlainBody(body);
    return cr;
};

CacheableResponse.prototype.isExpired = function() {
    var ttl = this.data[CacheableResponse.FIELD_TTL];
    if (!ttl) {
        return true;
    }
    return System.currentTimeMillis() > ttl;
};

CacheableResponse.prototype.touch = function(ttl) {
    this.data[CacheableResponse.FIELD_TTL] = new Long(System.currentTimeMillis() + (ttl || 10000));
};

CacheableResponse.prototype.setStatus = function(status) {
    this.data[CacheableResponse.FIELD_STATUS] = new java.lang.String(status);
};

CacheableResponse.prototype.getStatus = function() {
    return this.data[CacheableResponse.FIELD_STATUS];
};

CacheableResponse.prototype.setHeaders = function(headers) {
    this.data[CacheableResponse.FIELD_HEADERS] = new java.lang.String(JSON.stringify(headers));
};

CacheableResponse.prototype.getHeaders = function() {
    return JSON.parse(this.data[CacheableResponse.FIELD_HEADERS]);
};

CacheableResponse.prototype.setPlainBody = function(body) {
    this.data[CacheableResponse.FIELD_PLAIN_BODY] = new java.lang.String(JSON.stringify(body));
};

CacheableResponse.prototype.getPlainBody = function(body) {
    return JSON.parse(this.data[CacheableResponse.FIELD_PLAIN_BODY]);
};

CacheableResponse.prototype.setGzipedBody = function(body) {
    this.data[CacheableResponse.FIELD_GZIPED_BODY] = body;
};

CacheableResponse.prototype.getGzipedBody = function(body) {
    return [new ByteString(this.data[CacheableResponse.FIELD_GZIPED_BODY])];
};

CacheableResponse.prototype.hasGzipedBody = function() {
    return this.data[CacheableResponse.FIELD_GZIPED_BODY] !== null;
};