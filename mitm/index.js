'use strict';

/************************************************************************************
 * ---------------------- Required Packages START Block -----------------------------
 ************************************************************************************/

let path            = require('path'),
    fs              = require('fs'),
    zlib            = require('zlib'),
    initialize      = require('./keys'),
    readline        = require('readline'),
    child_process   = require('child_process'),
    Stream          = require('stream'),
    ssh2            = require('ssh2'),
    uuid            = require('uuid'),
    mysql           = require('mysql'),
    os              = require('os'),
    printAscii      = require('print-ascii'),
    d3_random       = require("d3-random"),
    seedrandom      = require("seedrandom"),
    moment          = require('moment'),
    fixedQueue      = require('fixedqueue').FixedQueue,
    crypt3          = require('crypt3/sync');

let config;
let version = 1.01

const {execSync} = require('child_process');

/************************************************************************************
 * ---------------------- Required Packages END Block -------------------------------
 ************************************************************************************/

/************************************************************************************
 * ---------------------- MITM Global Variables START Block -------------------------
 ************************************************************************************/

// Critical Variables
let className, groupId, runID, containerIP, containerID, containerMountPath;

// Cleanup Variable
let cleanup = false;

// SSH Keys - try to load the key from the container; otherwise, use the default key.
let DEFAULT_KEYS = {
    PRIVATE: fs.readFileSync(path.resolve(__dirname, 'defaultKey')),
    PUBLIC: fs.readFileSync(path.resolve(__dirname, 'defaultKey.pub')),
};

// Automatic Access Variables
let autoAccess = false;
let autoBarrier  = true; // false indicates that the barrier has been taken down so the login attempt will be successful.
let autoIPs; // Queue for the IPs
let autoRandomNormal = null;

// MySQL Pool (Instructor Use)
let pool = null;

// Logging files
var loginAttempts, logins, delimiter = ';';

/************************************************************************************
 * ---------------------- MITM Global Variables END Block ---------------------------
 ************************************************************************************/

/************************************************************************************
 * ---------------------- Logging START Block ---------------------------------------
 ************************************************************************************/

function debugLog(message, DBLog_ = true)
{
    if (config.debug) {
        message = moment().format("YYYY-MM-DD HH:mm:ss.SSS") + ' - [Debug] ' + message;
        console.log(message);

        if(DBLog_)
        {
            DBLog('debug', message);
        }
    }
}

function infoLog(message, DBLog_ = true)
{
    message = moment().format("YYYY-MM-DD HH:mm:ss.SSS") + ' - [Info] ' + message;
    console.log(message);

    if(DBLog_)
    {
        DBLog('info', message);
    }
}

function errorLog(message, DBLog_ = true)
{
    message = moment().format("YYYY-MM-DD HH:mm:ss.SSS") + ' - [Error] ' + message;
    console.error(message);

    if(DBLog_)
    {
        DBLog('error', message);
    }
}

/************************************************************************************
 * ---------------------- Logging END Block -----------------------------------------
 ************************************************************************************/

infoLog('MITM Version: ' + version);

// argv[2] = Class_GroupID (e.g. HACS200_2A), argv[3] = Host MITM port, argv[4] = Container IP, argv[5] = Container ID, argv[6] = Force Enable/Disable Auto Access (Boolean), argv[7] = Specify MITM config file
if (!(process.argv[2] && process.argv[3] && process.argv[4]) && process.argv[5]) {
    console.error('Usage: node %s <Class_GroupID (e.g. HACS200_2A)> <Host MITM Port> <Container IP> <Container ID> [autoAccess]', path.basename(process.argv[1]));
    process.exit(1);
} else {
    groupId = process.argv[2];
    containerIP = process.argv[4];
    containerID = parseInt(process.argv[5]);

    // ------ Instructor Block START -------
    if(groupId.indexOf("HACS") === -1 || (groupId.split("_")).length !== 2)
    {
        errorLog("Incorrect Class_GroupID (e.g. HACS200_2A)");
        process.exit();
    }
    className = (groupId.split("_"))[0];
    groupId = (groupId.split("_"))[1];
    // ------ Instructor Block END ---------

    // Load MITM config file
    if(process.argv[7]) {
        config = require('../config/' + process.argv[7]);
    }
    else {
        config = require('../config/mitm.js');
    }

    autoIPs = new fixedQueue(config.autoAccess.cacheSize);
    containerMountPath = path.resolve(config.container.mountPath, process.argv[5]);

    // Load Auto Access value from the config file
    autoAccess = config.autoAccess.enabled;
    if (process.argv[6]) {
        // Overwritten using the CLI
        autoAccess = (process.argv[6] === 'true');
    }

    // Barrier active is autoAccess active
    autoBarrier = autoAccess;

    infoLog("Auto Access Enabled: " + autoAccess);
    debugLog("[Init] Auto Access Barrier: " + autoBarrier);

    // Set up Normal Distribution Random Generator if enabled
    if(config.autoAccess.barrier.normalDist.enabled)
    {
        autoRandomNormal = d3_random.randomNormal.source(seedrandom())(
            config.autoAccess.barrier.normalDist.mean, config.autoAccess.barrier.normalDist.standardDeviation);
    }
    else if(!config.autoAccess.barrier.fixed.enabled)
    {
        errorLog("[Auto Access] Auto Access is enabled but none of the barriers are!");
        process.exit();
    }

    // ------ Instructor Block -----
    if(config.logToInstructor.enabled)
    {
        pool = mysql.createPool({
            connectionLimit : config.logToInstructor.connectionLimit,
            host            : config.logToInstructor.host,
            user            : config.logToInstructor.user,
            password        : config.logToInstructor.password,
            database        : config.logToInstructor.database
        })
    }
    // ------ Instructor Block -----


    // Do not do the following locally
    if(config.local === false)
    {
        // Mount container if required
        execSync("python3 " + path.resolve(__dirname, '../lxc/ensure_mount.py') + " -n " + containerID + "", (error, stdout, stderr) => {});

        // makes the attacker session screen output folder if not already created
        initialize.makeOutputFolder(config.logging.streamOutput);
        initialize.makeOutputFolder(config.logging.loginAttempts);
        initialize.makeOutputFolder(config.logging.logins);

        loginAttempts   = fs.createWriteStream(path.resolve(config.logging.loginAttempts, containerID + ".txt"), {flags:'a'});
        logins          = fs.createWriteStream(path.resolve(config.logging.logins, containerID + ".txt"), {flags:'a'});
    }

    // loads private and public keys from container if possible
    initialize.loadKeys(containerID, function (hostKeys) {
        startServer(hostKeys, parseInt(process.argv[3]));
    });
}

/**
 * Start the main SSH2 server
 * @name startServer
 * @static
 * @method
 * @param {String} hostKeys
 * @param {Number} port
 */
function startServer(hostKeys, port) {

    // Initialize the SSH server. Upon receiving a connection, handleAttackerConnection function will be called
    let server = new ssh2.Server({
        hostKeys: hostKeys,
        ident: config.server.identifier, // Identifier sent to the client
    }, handleAttackerConnection);

    // Bind SSH server to IP address and port
    server.listen(port, config.server.listenIP, function () { // function called when the server has successfully set up
        infoLog('SSH man-in-the-middle server for ' + containerIP + ' listening on ' +
            config.server.listenIP + ':' + this.address().port);

        // ---- Instructor Block START -------
        if(config.logToInstructor.enabled)
        {
            logStartMITM(port);
        }
        // ---- Instructor Block END ---------
    });
}

process.on('disconnect', function () {
    process.exit(); // if parent IPC is disconnected, kill the process
});

/**
 * Handle an incoming attacker connection
 * @name handleAttackerConnection
 * @static
 * @method
 * @param {Object} attacker - SSH2 Client Object
 */
function handleAttackerConnection(attacker) {

    attacker.on('error', function (err) {
        // If/when an error occurs on this attacker object, then this anonymous function will be called
        if (err.code === 'ECONNRESET' || err.message === 'Handshake failed: no matching key exchange algorithm') {
            return;
        }
        debugLog('[Connection] Client error on ssh server', err);
    });

    // Sanity check
    if (attacker._sock._peername === undefined || attacker._sock._peername === null) {
        debugLog("[Connection] Socket Error");
        return;
    }

    // Get the IP address of the attacker (the client end of the connection)
    let ipAddress = attacker._sock._peername.address;
    debugLog('[Connection] Attacker connected: ' + ipAddress);

    // When attacker exits before he or she has authenticated
    attacker.on('end', attackerEndBeforeAuthenticated);

    // Set a custom key for attacker to keep track of the number of login attempts for this connection
    attacker.numberOfAttempts = 0;

    // Set a custom key for the IP (in case something happens to the socket)
    attacker.ipAddress = ipAddress;

    // Handle Attacker Authentication method. handleAttackerAuthCallback is called when the
    // the function handleAttackerAuth calls it using "cb(param1, param2, etc...)"
    handleAttackerAuth(attacker, handleAttackerAuthCallback);
}

/**
 * When the attacker closes the connection before he or she has authentication,
 * then this function will be called
 *
 */
function attackerEndBeforeAuthenticated()
{
    debugLog("[Connection] Attacker closed the connection");
}

/**
 * Handle authentication from the attacker client
 * @name handleAttackerAuth
 * @static
 * @method
 * @param {Object} attacker - SSH2 Client Object
 * @param {Function} cb - function(err, lxc, ctx, attacker) - lxc is the container channel - ctx is the auth ctx - attacker is the connection
 */
function handleAttackerAuth(attacker, cb) {

    // Binds the "authentication" event to the attacker object. Now, whenever the attacker tries to authenticate, this
    // anonymous function will be called.
    attacker.on('authentication', function (ctx) {
        debugLog('[Auth] Attacker ' + attacker.ipAddress + " trying to authenticate with \"" + ctx.method + "\"");

        // Logging to instructor DB
        logLoginAttempt(attacker, ctx);

        if (ctx.method === 'password') {
            // The attacker is trying to authenticate using the "password" authentication method

            // Logging to student file
            loginAttempts.write(moment().format("YYYY-MM-DD HH:mm:ss.SSS") + delimiter + attacker.ipAddress + delimiter +
                ctx.method + delimiter + ctx.username + delimiter + ctx.password + "\n");

            // ----------- Automatic Access START Block --------------

            // Handle Attempt if automatic access is enabled
            if(autoAccess === true && autoBarrier === true)
            {
                handleAttempt(attacker);
            }

            // If automatic access is enabled and the barrier is down, then compromise the honeypot by
            // adding the user to the container if it does not exist and modifying the password for
            // specified user supplied by the attacker (ctx.username)
            if (autoAccess === true && autoBarrier === false) {
                autoAccess = false;

                debugLog("[Auto Access] Compromising the honeypot");

                // add user to the container if it does not exist
                execSync("python " + path.resolve(__dirname, '../lxc/execute_command.py') + " " + containerID +
                    " useradd " + ctx.username + " -m -s /bin/bash >  /dev/null 2>&1 || true", (error, stdout, stderr) => {});

                debugLog("[Auto Access] Adding the following credentials: \""
                    + ctx.username + ":" + ctx.password +"\"");

                execSync("python " + path.resolve(__dirname, '../lxc/execute_command.py') + " " + containerID +
                    " usermod -p `openssl passwd " + ctx.password + "` " + ctx.username);


            } else if (autoAccess === true && autoBarrier === true) {
                // Barrier has not yet been broken
                cb("Not yet compromised", null, ctx, attacker);
                return;
            }

            // ----------- Automatic Access END Block --------------

            // ----------- START Preliminary Authentication --------------
            // Preliminary authentication to alleviate the load on the container SSH server

            let passwordEntry = getPassEntry(ctx.username);

            //debugLog("[Auth] Password Field on container: " + passwordEntry);

            if(passwordEntry === null)
            {
                cb("Invalid credentials - User does not exist", undefined, ctx, attacker);
                return;
            }

            if(passwordEntry === '*' || passwordEntry === '!')
            {
                cb("Invalid credentials - Container user is disabled", undefined, ctx, attacker);
                return;
            }

            try {
                if( crypt3(ctx.password, passwordEntry) !== passwordEntry ) {
                    cb("Invalid credentials - Password Authentication Failure", undefined, ctx, attacker);
                    return;
                }
            } catch(err)
            {
                // If authentication threw an exception
                debugLog("[Auth] Exception thrown by crypt: " + err);
            }

            // ----------- END Preliminary Authentication --------------

            // Preliminary Authentication is successful, let's try to login using the attacker's credentials
            // Note: It may still fail because of the settings (/etc/ssh/sshd_config) that are put on the container SSH server
            debugLog('[LXC] Attempting to connect to the honeypot: ' + containerIP);

            connectToLXC({
                host: containerIP,
                port: 22,
                username: ctx.username,
                password: ctx.password
            }, function (err, lxc) { // function called after the login attempt to the container
                if(err)
                {
                    if(err.toString().indexOf('EHOSTUNREACH') !== -1)
                    {
                        errorLog('[LXC] Cannot reach the container!');
                    }
                    else if(err.toString() === 'Error: All configured authentication methods failed')
                    {
                        debugLog("[LXC] Authentication Failed");
                    }

                    cb(err.toString(), lxc, ctx, attacker);
                }

                cb(err, lxc, ctx, attacker);
            });
        }
        // Cannot fetch public keys from container when container does not exist (config.local = true)
        else if (ctx.method === 'publickey' && config.local === false) {
            // The attacker is trying to authenticate using the "publickey" authentication method

            // Logging to student file
            loginAttempts.write(moment().format("YYYY-MM-DD HH:mm:ss.SSS") + delimiter + attacker.ipAddress + delimiter +
                ctx.method + delimiter + ctx.username + delimiter + ctx.key.data.toString('base64') + "\n");

            // Verify that the public key sent by the attacker matches one of the public keys in the
            // ~/.ssh/authorized_keys. Note: ~ is the home directory of the supplied username
            if (verifyAuthKey(ctx.username, ctx.key.data.toString('base64'))) {

                // Home directory must exist because we were able to successfully verify that the publickey
                let homeDir = getHomeDir(ctx.username);
                let origAuthKeys = getAuthKeys(homeDir);
                let authKeysPath = path.join(containerMountPath, homeDir, '/.ssh/authorized_keys');
                let stats = getFileStat(authKeysPath);

                // Insert our own public key inside ~/.ssh/authorized keys since we don't have the private
                // key that the attacker used (which is normal). We use our private key to now gain
                // access to the honeypot system for the attacker.
                insertAuthKeys(homeDir, DEFAULT_KEYS.PUBLIC);
                connectToLXC({
                    host: containerIP,
                    port: 22,
                    username: ctx.username,
                    key: DEFAULT_KEYS.PRIVATE,
                }, function (err, lxc) { // function called after the login attempt to the container
                    // Once we have successfully connected, restore the original "authorized_keys" file
                    setAuthKeys(homeDir, origAuthKeys);
                    // Set the time back to make it look like we didn't work with this file
                    setFileTimes(authKeysPath, stats.atime, stats.mtime);
                    cb(err, lxc, ctx, attacker);
                });
            }
            else {
                cb("Publickey authentication failed", undefined, ctx, attacker);
            }
        } else if (ctx.method === "keyboard-interactive") {
            // Reject keyboard-interactive authentication.
            // This SSH server can simply do "password" and "publickey" authentication
            cb("Keyboard-interactive is not supported", undefined, ctx, attacker);
        } else if(ctx.method === "none") {
            // Clients use this authentication method to determine the available authentication methods on the SSH server
            // since the SSH server will reject the response with the available authentication methods.
            cb("No authentication method provided", undefined, ctx, attacker);
        } else {
            // ??? What is this attacker trying to do?
            cb('Unknown authentication method', undefined, ctx, attacker);
        }
    });
}

/**
 * Used when autoAccess is enabled. Determines if the attacker is allowed automatic access to the honeypot
 * @param attacker
 */
function handleAttempt(attacker) {
    // If autoAccess is disabled, what are we doing here?
    if(autoAccess === false)
    {
        return;
    }

    let ipAddress = attacker.ipAddress;
    let previouslySeen = false;

    // See if we have already an entry for this IP
    autoIPs.forEach(function (entry) {
        if (entry.IP === ipAddress) {
            // We have an entry, let's increment attempts
            previouslySeen = entry;
            entry.attempts++;
        }
    });

    // If we have not seen this IP before
    if (previouslySeen === false) {
        let randomAllowCalculation = null;

        // Normal Distribution Barrier
        if(config.autoAccess.barrier.normalDist.enabled)
        {
            randomAllowCalculation = Math.round(autoRandomNormal());
        }
        // Fixed Number of Attempts Barrier
        else if(config.autoAccess.barrier.fixed.enabled)
        {
            randomAllowCalculation = config.autoAccess.barrier.fixed.attempts;
        }
        // No way to calculate randomAllow...
        else
        {
            errorLog("[Auto Access] Unknown calculation for randomAllow!");
            randomAllowCalculation = Number.MAX_VALUE;
        }

        // Place it in the queue
        autoIPs.enqueue({
            IP: ipAddress,
            attempts: 0,
            randomAllow: randomAllowCalculation
        });

        // Get the entry from the queue
        autoIPs.forEach(function (entry) {
            if (entry.IP === ipAddress) {
                previouslySeen = entry;
                entry.attempts++;
            }
        });
    }

    // If the number of attempts is greater than or equal to the set threshold for this attacker
    if (previouslySeen.attempts >= previouslySeen.randomAllow) {
        autoBarrier = false;
    }

    debugLog("[Auto Access] Attacker: " + ipAddress + ", Threshold: " + previouslySeen.randomAllow + ", Attempts: " + previouslySeen.attempts);
}


function handleAttackerAuthCallback(err, lxc, authCtx, attacker)
{
    // If an error has occurred with authentication (e.g. Invalid credentials)
    if (err) {
        debugLog('[Auth] Attacker authentication error: ' + err);

        try {
            // The MITM SSH server will reject the credentials with the available authentication methods
            authCtx.reject(['publickey', 'password']);
        } catch (err) {
            if (err.message !== 'No auth in progress') {
                // It's okay, attacker just disconnected
                errorLog('[AUTH] Failed to reject authentication');
            }
        }

        // -------- Attacker Limit Number of Attempts per Connection START ------------

        // If the authentication method was not "none", then increment the login attempts count
        if (authCtx.method !== 'none') {
            attacker.numberOfAttempts++;
            debugLog("[Auth] Attacker: " + attacker.ipAddress + " has so far made " + attacker.numberOfAttempts +
                " attempts. Remaining: " +
                (config.server.maxAttemptsPerConnection - attacker.numberOfAttempts) + " attempts");
        }

        // If the number of attempts for this attacker connection is equal to
        // the maximum number of attempts allowed per connection, then close the connection on the attacker
        if (attacker.numberOfAttempts === config.server.maxAttemptsPerConnection) {
            debugLog("[Connection] Max Login Attempts Reached - Closing connection on attacker");
            attacker.end();
        }

        // -------- Attacker Limit Number of Attempts per Connection END ---------------
    } else {
        attacker.once('ready', function () { // authenticated user

            // Remove previous event listener for when attacker closed the connection
            attacker.removeListener('end', attackerEndBeforeAuthenticated);

            debugLog('[Auth] Attacker authenticated');
            let sessionId = uuid.v1(); // assign UUID

            // make a session screen output stream
            let screenWriteOutputStream = fs.createWriteStream(
                path.resolve(config.logging.streamOutput, sessionId + '.gz')
            );

            // Make a Gzip handler to automatically compress the file on the fly
            let screenWriteGZIP = zlib.createGzip();
            screenWriteGZIP.pipe(screenWriteOutputStream);

            /*let year = dateTime.getFullYear(), month = ("0" + dateTime.getMonth()).slice(-2),
                date = ("0" + dateTime.getDate()).slice(-2), hour = ("0" + dateTime.getHours()).slice(-2),
                minutes = ("0" + dateTime.getMinutes()).slice(-2), seconds = ("0" + dateTime.getSeconds()).slice(-2),
                milliseconds = dateTime.getMilliseconds();*/

            let metadata = containerIP + '_' + containerID + "_" + attacker.ipAddress + "_" +
                moment().format("YYYY_MM_DD_HH_mm_ss_SSS") + "_" + sessionId + "\n" +
                "Container SSH Server: " + containerIP + "\n" +
                "Container ID: " + containerID + "\n" +
                "Attacker IP Address: " + attacker.ipAddress + "\n" +
                "Date: " + moment().format("YYYY-MM-DD HH:mm:ss.SSS") + "\n" +
                "Session ID: " + sessionId + "\n" +
                "-------- Attacker Stream Below ---------\n";

            let metadataBuffer = new Buffer(metadata, "utf-8");
            screenWriteGZIP.write(metadataBuffer);

            // Log to instructor DB
            logLogin(attacker, authCtx, sessionId);

            // Log to student file
            logins.write(moment().format("YYYY-MM-DD HH:mm:ss.SSS") + delimiter + attacker.ipAddress + delimiter +
                sessionId + "\n");

            attacker.once('session', function (accept) {
                let session = accept();
                if (session) {
                    handleAttackerSession(session, lxc, sessionId, screenWriteGZIP);
                }
            });
            attacker.on('end', function () {
                debugLog('[Connection] Attacker closed connection');
                lxc.end();
                screenWriteGZIP.end(); // end attacker session screen output write stream
                // Log sign out event

                //execute recycling script once an attacker has connected and
                //authenticated
                execSync("/root/scripts/recycle.sh " + containerID);
            });
        });
        // Disconnect LXC client when attacker closes window
        authCtx.accept();
    }
}

/************************************************************************************
 * ------------- You should not need to modify anything below -----------------------
 * ------------------------  Proceed with caution -----------------------------------
 ************************************************************************************/


/**
 *
 * @param attacker
 * @param lxc
 * @param sessionId
 * @param screenWriteStream
 */
function handleAttackerSession(attacker, lxc, sessionId, screenWriteStream) {
    let attackerStream, rows, cols, term;
    let lxcStream;


    attacker.once('pty', function (accept, reject, info) {
        rows = info.rows;
        cols = info.cols;
        term = info.term;
        accept && accept();
        attacker.on('window-change', function (accept, reject, info) {
            if (attackerStream) {
                attackerStream.rows = info.rows;
                attackerStream.columns = info.cols;
                attackerStream.emit('resize');
                lxcStream.setWindow(info.rows, info.cols);
            }
            accept && accept();
        });
    });

    // Non-interactive mode
    attacker.on('exec', function (accept, reject, info) {
        debugLog('[EXEC] Noninteractive mode attacker command: ' + info.command);
        // Log command to DB
        /*socket.emit('command', {
          sessionId : sessionId,
          line : info.command,
          keystrokes : [], // intentionally empty to specify that this is a non-interactive session
          timestamp : new Date()
        });*/

        let execStatement = 'Noninteractive mode attacker command: ' + info.command + '\n--------- Output Below -------\n';

        let execStatementBuffer = new Buffer(execStatement, "utf-8");
        screenWriteStream.write(execStatementBuffer);

        lxc.exec(info.command, function (err, lxcStream) {
            if (err) {
                return errorLog('lxc exec error', err);
            }
            attackerStream = accept();
            lxcStream.on('data', function (data) {
                screenWriteStream.write(data); // log command results to disk
                attackerStream.write(data);
            });
            lxcStream.on('close', function () {
                attackerStream.end();
            });
        });
    });

    // Interactive mode
    attacker.on('shell', function (accept) {
        lxc.shell({
            rows: rows || 24,
            cols: cols || 80,
            term: term || 'ansi'
        }, function (err, lxcStreamObj) {
            lxcStream = lxcStreamObj;
            lxcStream.isTTY = true;

            debugLog('[SHELL] Opened shell for attacker');
            attackerStream = accept();
            attackerStream.isTTY = true;
            attackerStream.rows = rows || 24;
            attackerStream.columns = cols || 80;
            attackerStream.term = term || 'ansi';
            let keystrokeBuffer = [];
            let attackerStreamCopy = new Stream.PassThrough();
            let reader = readline.createInterface({
                input: attackerStreamCopy,
                terminal: true
            });

            let keystrokeFullBuffer = '';

            reader.on('line', function (line) {
                debugLog('[SHELL] line from reader: ' + line.toString());
                debugLog('[SHELL] Keystroke buffer: ' + keystrokeBuffer);
                /*socket.emit('command', {
                  sessionId : sessionId,
                  line : line,
                  keystrokes : keystrokeBuffer,
                  timestamp : new Date()
                });*/
                keystrokeBuffer = []; // reset char array
            });

            lxcStream.on('data', function (data) {
                screenWriteStream.write(data); // write screen to disk
                attackerStream.write(data);
            });
            attackerStream.on('data', function (data) {
                debugLog('[SHELL] Attacker Keystroke: ' + printAscii(data.toString()));
                keystrokeFullBuffer += moment().format('YYYY-MM-DD HH:mm:ss.SSS') + ': ' + printAscii(data.toString()) + "\n";

                lxcStream.write(data);
                // record all char code of keystrokes
                let dataString = data.toString();
                let dataCopy = '';
                for (let i = 0, len = dataString.length; i < len; i++) {
                    keystrokeBuffer.push(dataString.charCodeAt(i));
                    if (dataString.charCodeAt(i) !== 3) { // 3 is ctrl-c, readline doesn't like ctrl-c
                        dataCopy += dataString.charAt(i);
                    }
                }

                // push to stream copy for readline
                attackerStreamCopy.write(dataCopy);
            });

            attackerStream.on('end', function () {
                debugLog('[SHELL] Attacker ended the shell');

                // Keystroke Writing
                screenWriteStream.write("-------- Attacker Keystrokes ----------\n");
                screenWriteStream.write(keystrokeFullBuffer);
                lxcStream.end();
            });

            lxcStream.on('end', function () {
                debugLog('[SHELL] Honeypot ended shell');
                attackerStream.end();
            });
        });
    });
}

/************************************************************************************
 * ------------------------------- LXC START Block ----------------------------------
 ************************************************************************************/

/**
 * Connect to a honeypot LXC container
 * @name connectToLXC
 * @static
 * @method
 * @param {Object} opts - {host, port, username, password | key}
 * @param {Function} cb - function(err, lxc)
 */
function connectToLXC(opts, cb) {
    let lxc = new ssh2.Client();

    let connectOptions;
    if (opts.password) { // password authentication
        connectOptions = {
            host: opts.host,
            port: opts.port,
            username: opts.username,
            password: opts.password,
            readyTimeout: 30000,
        };
    } else if (opts.key) { // key authentication
        connectOptions = {
            host: opts.host,
            port: opts.port,
            username: opts.username,
            privateKey: opts.key
        }
    } else {
        return cb('Invalid authentication method');
    }

    lxc.on('ready', function () { // allow authenticate
        autoAccess = false; // Attacker is successfully getting inside the container

        return cb(undefined, lxc);
    });
    lxc.on('close', function (err) {
        if (err) {
            errorLog('LXC close error', err);
        }
        debugLog('[LXC] Container\'s OpenSSH server closed connection');
    });
    lxc.on('end', function () {
        debugLog('[LXC] Container\'s OpenSSH server ended connection');
    });
    lxc.on('error', function (err) {
        return cb(err);
    });

    lxc.connect(connectOptions); // connect to the LXC container
}

/************************************************************************************
 * ------------------------------- LXC END Block ------------00----------------------
 ************************************************************************************/


/************************************************************************************
 * ----------------------- Authentication START Block -------------------------------
 ************************************************************************************/

/**
 * Test to see if attacker provided public key is in the destination home directory
 * @static
 * @method
 * @param {String} username
 * @param {String} pubKey
 * @returns {Boolean}
 */
function verifyAuthKey(username, pubKey) {
    let matches = false;
    let targetHomeDir = getHomeDir(username);

    // User's home directory does not exist
    if (targetHomeDir === null || targetHomeDir === '') {
        return false;
    }

    getAuthKeys(targetHomeDir).split('\n').forEach(function (line) {
        let columns = line.split(' ');
        //let alg = columns[0];
        let key = columns[1];
        //let comment = columns[2];
        if (key === pubKey) {
            matches = true;
        }
    });

    return matches;
}

function getHomeDir(username) {
    let passwd = undefined;

    // Try to read the contents of the container's /etc/passwd file
    try {
        passwd = fs.readFileSync(path.join(containerMountPath, '/etc/passwd')).toString();
    } catch (e) {
        if (e.code !== 'ENOENT') {
            errorLog(e);
            return undefined;
        }
    }

    let targetHomeDir = null;
    passwd.split('\n').forEach(function (line) {
        let columns = line.split(':');
        let user = columns[0];
        let homedir = columns[5];
        if (user === username) {
            targetHomeDir = homedir;
        }
    });

    return targetHomeDir;
}

function getPassEntry(username)
{
    let passwd = undefined;

    // Try to read the contents of the container's /etc/passwd file
    try {
        passwd = fs.readFileSync(path.join(containerMountPath, '/etc/shadow')).toString();
    } catch (e) {
        if (e.code !== 'ENOENT') {
            errorLog(e);
            return undefined;
        }
    }

    let pass = null;
    passwd.split('\n').forEach(function (line) {
        let columns = line.split(':');
        let user = columns[0];
        let userPass = columns[1];
        if (user === username) {
            pass = userPass;
        }
    });

    return pass;
}

function getAuthKeys(homedir) {
    try {
        return fs.readFileSync(path.join(containerMountPath, homedir, '/.ssh/authorized_keys')).toString();
    } catch (e) {
        return '';
    }
}

function setAuthKeys(homedir, authKeys) {
    try {
        fs.writeFileSync(path.join(containerMountPath, homedir, '/.ssh/authorized_keys'), authKeys);
    } catch (e) {
        errorLog(e);
    }
}

function insertAuthKeys(homedir, authKey) {
    try {
        fs.appendFileSync(path.join(containerMountPath, homedir, '/.ssh/authorized_keys'), authKey);
    } catch (e) {
        errorLog(e);
    }
}

function getFileStat(file) {
    try {
        let stat = fs.statSync(file);
        return {
            atime: stat.atime,
            mtime: stat.mtime,
            ctime: stat.ctime
        };
    } catch (e) {
        errorLog(e);
        return {};
    }
}

function setFileTimes(file, atime, mtime) {
    try {
        fs.utimesSync(file, atime, mtime);
    } catch (e) {
        errorLog(e);
    }
}

/************************************************************************************
 * ----------------------- Authentication END Block ---------------------------------
 ************************************************************************************/

/************************************************************************************
 * ----------- Do NOT modify anything below - Instructor Use ------------------------
 ************************************************************************************/

/************************************************************************************
 * ----------- Do NOT modify anything below - Instructor Use ------------------------
 ************************************************************************************/

/************************************************************************************
 * ----------- Do NOT modify anything below - Instructor Use ------------------------
 ************************************************************************************/

/************************************************************************************
 * ----------- Do NOT modify anything below - Instructor Use ------------------------
 ************************************************************************************/

function getNetworkInterfaceDetails()
{
    let networkInterfaces = os.networkInterfaces();
    let interfaceDetailsShort = {};

    // Iterate through each interface name
    Object.keys(networkInterfaces).forEach(function(interfaceName) {

        // Iterate through each interface address
        networkInterfaces[interfaceName].forEach(function(interface_) {

            // If interface is not IPv4 and/or is internal
            if(interface_.family !== 'IPv4' || interface_.internal !== false)
            {
                return;
            }

            if(interfaceDetailsShort[interfaceName] === undefined)
            {
                interfaceDetailsShort[interfaceName] = [{
                    'cidr' : interface_.cidr,
                    'mac'  : interface_.mac,
                }]
            }
            else
            {
                interfaceDetailsShort[interfaceName].push({
                    'cidr' : interface_.cidr,
                    'mac'  : interface_.mac,
                });
            }
        });
    });

    return interfaceDetailsShort;
}


/**
 * Logs Group ID, Destination Server
 * @param port
 */
function logStartMITM(port)
{
    if(pool === null)
    {
        errorLog("DB connection failed - contact an instructor or a TA");
        process.exit();
    }

    let networkInterfaceDetails = getNetworkInterfaceDetails();

    let query = 'INSERT INTO ' +
        'mitm_start(class_name, group_id, host_interfaces, mitm_listen_ip, mitm_port, auto_access, auto_access_details, container_id, container_ip, container_mount, started_at)' +
        'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

    let values = [
        className,
        groupId,
        JSON.stringify(networkInterfaceDetails),
        config.server.listenIP,
        port,
        autoAccess,
        JSON.stringify(config.autoAccess),
        containerID,
        containerIP,
        containerMountPath,
        moment().format("YYYY-MM-DD HH:mm:ss.SSS")
    ];

    pool.query(query, values, function(error, result) {
        if(error)
        {
            errorLog("The following is a DB Error, please contact an instructor or a TA: ", false);
            errorLog(error, false);
            return;
        }

        runID = result.insertId;
        debugLog("Your session ID: " + runID);
    });
}

function DBLog(type, message)
{
    // Error checking
    if(pool === null || !runID)
    {
        return;
    }

    let query = 'INSERT INTO ' +
        'mitm_log(mitm_start_id, type, message)' +
        'VALUES(?, ?, ?)';

    let values = [
        runID,
        type,
        message
    ];

    logToDB(query, values);
}


function logLoginAttempt(attacker, ctx)
{
    // Error checking
    if(pool === null || !runID)
    {
        return;
    }

    let query = 'INSERT INTO ' +
        'mitm_login_attempts(mitm_start_id, attacker_ip, method, username, password, public_key, number_of_attempts, attempted_at) ' +
        'VALUES(?, ?, ?, ?, ?, ?, ?,?)';

    let password = null;
    let publicKey = null;

    if(ctx.method === 'password')
    {
        password = ctx.password;
    }
    else if(ctx.method === 'publickey')
    {
        publicKey = ctx.key.data.toString('base64');
    }

    let values = [
        runID,
        attacker.ipAddress,
        ctx.method,
        ctx.username,
        password,
        publicKey,
        attacker.numberOfAttempts,
        moment().format("YYYY-MM-DD HH:mm:ss.SSS"),
    ];

    logToDB(query, values);
}

function logLogin(attacker, ctx, sessionId)
{
    // Error checking
    if(pool === null || !runID)
    {
        return;
    }

    let query = 'INSERT INTO ' +
        'mitm_logins(mitm_start_id, attacker_ip, session_id, method, username, password, public_key, number_of_attempts, login_at) ' +
        'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)';

    let password = null;
    let publicKey = null;

    if(ctx.method === 'password')
    {
        password = ctx.password;
    }
    else if(ctx.method === 'publickey')
    {
        publicKey = ctx.key.data.toString('base64');
    }

    let values = [
        runID,
        attacker.ipAddress,
        sessionId,
        ctx.method,
        ctx.username,
        password,
        publicKey,
        attacker.numberOfAttempts,
        moment().format("YYYY-MM-DD HH:mm:ss.SSS"),
    ];

    logToDB(query, values);
}


function logToDB(query, values)
{
    pool.query(query, values, function(error) {
        if(error)
        {
            errorLog("The following is a DB Error, please contact an instructor or a TA: ", false);
            errorLog(error, false);
        }
    });
}

// Some housekeeping on exit

process.on('exit', function() {
    housekeeping("exit");
});
process.on('SIGINT', function() {
    housekeeping("SIGINT");
});
process.on('SIGUSR1', function() {
    housekeeping("SIGUSR1");
});
process.on('SIGUSR2', function() {
    housekeeping("SIGUSR2");
});
process.on('uncaughtException', function(err) {
    housekeeping("UncaughtException", err.message)
});

function housekeeping(type, details = null)
{
    if(cleanup === false)
    {
        infoLog("Exiting...");
        cleanup = true;
        debugLog("Cleaning up...", false);

        if(details !== null)
        {
            errorLog("Exception occurred: ", false);
            console.log(details);
        }

        cleanupPool(type, details, function() {
            process.exit();
            logins.end();
            loginAttempts.end();
        });
    }
}


function cleanupPool(type, details, cb)
{
    if(pool === null) {
        cb();
        return;
    }

    let query = 'INSERT INTO ' +
        'mitm_stop (mitm_start_id, exit_type, exit_details, stopped_at) ' +
        'VALUES(?, ?, ?, ?)';

    let values = [
        runID,
        type,
        details,
        moment().format("YYYY-MM-DD HH:mm:ss.SSS"),
    ];

    pool.query(query, values, function(error) {
        if(error)
        {
            errorLog("DB Error:" + error);
        }

        pool.end(function() {
            cb();
        });
    });

}
