var ringohoard = require("./ringohoard");
var {Application} = require("stick"),
    {Server} = require("ringo/httpserver"),
    {Buffer} = require("ringo/buffer"),
    log = require("ringo/logging").getLogger("ringohoard-demo");

var app = exports.app = Application();
app.configure(ringohoard, "notfound", "mount");

app.mount("/hello", page("hello world!"));

function page(text) {
    return function(req) {
        log.info(text);
        return {
            status: 200,
            headers: {"Content-Type": "text/html"},
            body: new Buffer("<html><body>", text, "</body></html>") };
    }
};

// start server if run as main script
if (require.main === module) {
    require("ringo/httpserver").main(module.id);
}
