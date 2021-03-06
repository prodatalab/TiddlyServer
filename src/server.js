"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("../lib/source-map-support-lib");
const bundled_lib_1 = require("../lib/bundled-lib");
const sendOptions = {};
const server_types_1 = require("./server-types");
const http = require("http");
const fs = require("fs");
const path = require("path");
const util_1 = require("util");
const events_1 = require("events");
// import { parse as jsonParse } from 'jsonlint';
// import send = require('../lib/send-lib');
const { Server: WebSocketServer } = bundled_lib_1.ws;
__dirname = path.dirname(module.filename || process.execPath);
Error.stackTraceLimit = Infinity;
console.debug = function () { }; //noop console debug;
//setup global objects
exports.eventer = new events_1.EventEmitter();
const debug = server_types_1.DebugLogger('APP');
var ENV;
(function (ENV) {
    ENV.disableLocalHost = false;
})(ENV || (ENV = {}));
;
var settings;
//import and init api-access
const tiddlyserver_1 = require("./tiddlyserver");
const settingsPage_1 = require("./settingsPage");
server_types_1.init(exports.eventer);
tiddlyserver_1.init(exports.eventer);
settingsPage_1.initSettings(exports.eventer);
//emit settings to everyone (I know, this could be an observable)
const assets = path.resolve(__dirname, '../assets');
const favicon = path.resolve(__dirname, '../assets/favicon.ico');
const stylesheet = path.resolve(__dirname, '../assets/directory.css');
function loadSettings(settingsFile) {
    console.log("Settings file: %s", settingsFile);
    const settingsString = fs.readFileSync(settingsFile, 'utf8').replace(/\t/gi, '    ').replace(/\r\n/gi, '\n');
    let settingsObj = server_types_1.tryParseJSON(settingsString, (e) => {
        console.error(/*colors.BgWhite + */ server_types_1.colors.FgRed + "The settings file could not be parsed: %s" + server_types_1.colors.Reset, e.originalError.message);
        console.error(e.errorPosition);
        throw "The settings file could not be parsed: Invalid JSON";
    });
    if (!settingsObj.tree)
        throw "tree is not specified in the settings file";
    server_types_1.normalizeSettings(settingsObj, settingsFile);
    if (["string", "undefined"].indexOf(typeof settingsObj.username) === -1)
        throw "username must be a JSON string if specified";
    if (["string", "undefined"].indexOf(typeof settingsObj.password) === -1)
        throw "password must be a JSON string if specified";
    if (process.env.TiddlyServer_disableLocalHost || settingsObj._disableLocalHost)
        ENV.disableLocalHost = true;
    settingsObj.__assetsDir = assets;
    if (typeof settingsObj.tree === "object") {
        let keys = Object.keys(settingsObj.tree);
        let routeKeys = Object.keys(routes);
        let conflict = keys.filter(k => routeKeys.indexOf(k) > -1);
        if (conflict.length)
            console.log("The following tree items are reserved for use by TiddlyServer: %s", conflict.map(e => '"' + e + '"').join(', '));
    }
    return settingsObj;
}
exports.loadSettings = loadSettings;
// === Setup Logging
const morgan = require('../lib/morgan.js');
function setLog() {
    const logger = morgan.handler({
        logFile: settings.logAccess || undefined,
        logToConsole: !settings.logAccess || settings.logToConsoleAlso,
        logColorsToFile: settings.logColorsToFile
    });
    return settings.logAccess === false
        ? ((...args) => Promise.resolve([]))
        : (...args) => new Promise(resolve => {
            args.push((...args2) => resolve(args2));
            logger.apply(null, args);
        });
}
let log;
exports.eventer.on('settings', () => { log = setLog(); });
exports.eventer.on('settingsChanged', (keys) => {
    let watch = ["logAccess", "logToConsoleAlso", "logColorsToFile"];
    if (watch.some(e => keys.indexOf(e) > -1))
        log = setLog();
});
// === Setup static routes
const routes = {
    'admin': state => handleAdminRoute(state),
    'assets': state => handleAssetsRoute(state),
    'favicon.ico': state => server_types_1.serveFile(state, 'favicon.ico', assets),
    'directory.css': state => server_types_1.serveFile(state, 'directory.css', assets),
};
function initServer(options) {
    settings = options.settings;
    exports.eventer.emit('settings', options.settings);
    const { preflighter, env, listenCB } = options;
    const serverLocalHost = http.createServer();
    const serverNetwork = http.createServer();
    const addListeners = (server, iface) => {
        let closing = false;
        server.on('request', requestHandler(iface, preflighter));
        server.on('listening', () => {
            debug(1, "server %s listening", iface);
        });
        server.on('error', (err) => {
            debug(4, "server %s error: %s", iface, err.message);
            debug(4, "server %s stack: %s", iface, err.stack);
            server.close();
            process.exitCode = 2;
            exports.eventer.emit('serverClose', iface);
        });
        server.on('close', () => {
            if (!closing)
                exports.eventer.emit('serverClose', iface);
            debug(4, "server %s closed", iface);
            closing = true;
        });
        exports.eventer.on('serverClose', (closingiface) => {
            if (closingiface !== iface && !closing) {
                closing = true;
                server.close();
            }
        });
        const wss = new WebSocketServer({ server });
        wss.on('connection', (client, request) => {
            exports.eventer.emit('websocket-connection', client, request);
        });
        wss.on('error', (error) => {
            debug(-2, 'WS-ERROR %s', util_1.inspect(error));
        });
    };
    addListeners(serverLocalHost, "localhost");
    addListeners(serverNetwork, "network");
    const cb = function (...args) {
        if (listenCB)
            listenCB(settings.host, settings.port, ENV.disableLocalHost);
        serverListenCB.apply(this, args);
    };
    if (ENV.disableLocalHost) {
        serverNetwork.listen(settings.port, settings.host, cb);
    }
    else {
        serverLocalHost.listen(settings.port, "127.0.0.1", (err, res) => {
            if (settings.host !== "127.0.0.1") {
                serverNetwork.listen(settings.port, settings.host, cb);
            }
            else {
                cb(err, res);
            }
        });
    }
    return exports.eventer;
}
exports.initServer = initServer;
function requestHandler(iface, preflighter) {
    return (request, response) => {
        //send the request and response to morgan
        log(request, response).then(() => {
            const ev = {
                handled: false,
                trusted: false,
                interface: iface,
                request, response
            };
            //send it to the preflighter
            return preflighter ? preflighter(ev) : Promise.resolve(ev);
        }).then(ev => {
            // check if the preflighter handled it
            if (ev.handled)
                return;
            //create the state object
            const state = new server_types_1.StateObject(ev.request, ev.response, debug, exports.eventer, ev.trusted ? "trusted" : iface);
            //handle basic auth
            if (!handleBasicAuth(state))
                return;
            //check for static routes
            const route = routes[state.path[1]];
            //if so, handle it
            if (route)
                route(state);
            //otherwise forward to TiddlyServer
            else
                tiddlyserver_1.handleTiddlyServerRoute(state);
        }).catch(err => {
            //catches any errors that happen inside the then statements
            debug(3, 'Uncaught error in the request handler: ' + (err.message || err.toString()));
            //if we have a stack, then print it
            if (err.stack)
                debug(3, err.stack);
        });
    };
}
const errLog = server_types_1.DebugLogger('STATE_ERR');
exports.eventer.on("stateError", (state) => {
    if (state.doneMessage.length > 0)
        dbgLog(2, state.doneMessage.join('\n'));
});
const dbgLog = server_types_1.DebugLogger('STATE_DBG');
exports.eventer.on("stateDebug", (state) => {
    if (state.doneMessage.length > 0)
        dbgLog(-2, state.doneMessage.join('\n'));
});
function handleAssetsRoute(state) {
    switch (state.path[2]) {
        case "static":
            server_types_1.serveFolder(state, '/assets/static', path.join(assets, "static"));
            break;
        case "icons":
            server_types_1.serveFolder(state, '/assets/icons', path.join(assets, "icons"));
            break;
        case "tiddlywiki":
            tiddlyserver_1.handleTiddlyWikiRoute(state);
            break;
        default: state.throw(404);
    }
}
function handleAdminRoute(state) {
    switch (state.path[2]) {
        case "settings":
            settingsPage_1.handleSettings(state);
            break;
        default: state.throw(404);
    }
}
function serverListenCB(err, res) {
    if (err) {
        console.error('error on app.listen', err);
        return;
    }
    console.log('Open your browser and type in one of the following:');
    if (!settings.host || settings.host === '0.0.0.0') {
        var os = require('os');
        var ifaces = os.networkInterfaces();
        for (var dev in ifaces) {
            var alias = 0;
            ifaces[dev].forEach(function (details) {
                if (details.family == 'IPv4' && details.internal === false) {
                    console.log(details.address + (settings.port !== 80 ? ':' + settings.port : ''));
                    ++alias;
                }
            });
        }
    }
    else {
        console.log(settings.host + (settings.port !== 80 ? ':' + settings.port : ''));
    }
}
function handleBasicAuth(state) {
    //check authentication and do sanity/security checks
    //https://github.com/hueniverse/iron
    //auth headers =====================
    if (!settings.username && !settings.password)
        return true;
    const first = (header) => Array.isArray(header) ? header[0] : header;
    if (!state.req.headers['authorization']) {
        debug(-2, 'authorization required');
        state.respond(401, "", { 'WWW-Authenticate': 'Basic realm="TiddlyServer"', 'Content-Type': 'text/plain' }).empty();
        return false;
    }
    debug(-3, 'authorization requested');
    var header = first(state.req.headers['authorization']) || '', // get the header
    token = header.split(/\s+/).pop() || '', // and the encoded auth token
    auth = new Buffer(token, 'base64').toString(), // convert from base64
    parts = auth.split(/:/), // split on colon
    username = parts[0], password = parts[1];
    if (username !== settings.username || password !== settings.password) {
        debug(-2, 'authorization invalid - UN:%s - PW:%s', username, password);
        state.throwReason(401, 'Invalid username or password');
        return false;
    }
    debug(-3, 'authorization successful');
    // securityChecks =====================
    return true;
}
