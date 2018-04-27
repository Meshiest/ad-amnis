const irc = require('irc');
const DCC = require('irc-dcc');
const fs = require('fs');
const { Client } = require('node-rest-client');
const yaml = require('js-yaml');
const sqlite3 = require('sqlite3').verbose();
const Multiprogress = require('multi-progress');
const format = require('string-format');

const multi = new Multiprogress(process.stderr);

// needed to modify only this line for the irc-dcc library...
const resume_template = 'DCC RESUME "{filename}" {port} {position}';

// now I need to redeclare this..
DCC.prototype.acceptFile = function (from, host, port, filename, length, position, callback) {
  let self = this;
  if (typeof position === 'function') {
    callback = position;
    position = null;
  }

  let connection_options = {
    host: host,
    port: port,
    localAddress: self.localAddress
  };

  if (!position) {
    DCC.acceptAndConnectFile(connection_options, filename, callback);
    return;
  }
  
  self.client.ctcp(from, 'privmsg', format(resume_template, {
    filename: filename,
    port: port,
    position: position
  }));

  self.client.once('dcc-accept', (from, args) => {
    if (args.filename === filename && args.port === port) {
      DCC.acceptAndConnectFile(connection_options, filename, callback);
    }
  });
};

let rest = new Client();

// Create a directory if it doesn't exist
function mkdir(dir) {
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
  }
}

let config, client, dcc;
let downloading = {}, downloadInfo = {}, bars = {};

/* Loads the config and updates the feed if `shouldReadFeed` is true */
function loadConfig(shouldReadFeed=false) {
  try {
    //  Loading the config out of the config.yml file
    let oldName = config && config.settings.bot_name;
    config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

    // Create our config directories
    mkdir(config.settings.complete_dir);
    mkdir(config.settings.incomplete_dir);
    mkdir(config.settings.data_dir);

    if(shouldReadFeed) {
      readFeed();
      if(config.settings.bot_name !== oldName)
        client.say('nickserv', `set ${config.settings.bot_name}`);
    } else {
      client = new irc.Client('irc.rizon.net', config.settings.bot_name, {
        channels: [],
      });
      dcc = new DCC(client);
    }

  } catch (e) {
    console.error('Missing config.yml. Please reference config.yml.default');
    process.exit(1);
  }
}

loadConfig(false);

let reloadTimeout;
fs.watchFile('config.yml', (curr, prev) => {
  let time = Date.now();
  log('Config modified, reloading in 3 seconds');

  clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(() => loadConfig(true), 3000);
});


function log(...msg) {
  console.log(...msg);
}

const db = new sqlite3.Database(config.settings.data_dir + '/amnis.db');

// Create our downloaded episodes table
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_name VARCHAR(128) NOT NULL,
    download_time INTEGER NOT NULL,
    episode INTEGER NOT NULL
  );`);
  db.all('SELECT show_name, episode FROM episodes', (err, episodes) => {
    log('Hello! Found', err ? [] : Array.from(episodes).length, 'episodes in the database!');
  });
});

// Gets a list of episodes from a given show
function getEpisodes(show) {
  return new Promise(resolve => {
    db.serialize(() => {
      db.all('SELECT episode FROM episodes WHERE show_name=?', show, (err, episodes) => {
        resolve(err ? [] : Array.from(episodes).map(e => e.episode));
      });
    });
  });
}

// Matches episode name from show names
function getEpisodesFromShow(show) {
  return new Promise(resolve => {
    db.serialize(() => {
      db.all('SELECT * FROM episodes', (err, episodes) => {
        if(err)
          reject(err);
        else {
          resolve(
            // find only matching shows
            episodes.filter(e =>
              e.show_name.toLowerCase()
                .match(show.pattern.toLowerCase()))
          );
        }
      });
    });
  });
}

// Store an episode for a show as downloaded
function putEpisode(show, episode) {
  db.serialize(() => {
    db.prepare('INSERT INTO episodes (show_name, download_time, episode) VALUES (?, ?, ?);')
      .run(show, Math.floor(Date.now() / 1000), episode);
  });
}

// Extracts show name, episode, and resolution from a file name
function metaFromFilename(filename) {
  const [, show, episode, resolution ] = (filename || '').match(/\[HorribleSubs\] (.+?) - (\d+) \[(1080|720|480)p\]\.mkv$/) || [];
  return { show, episode: parseInt(episode), resolution: parseInt(resolution) };
}

// Searches horriblesubs' xdcc catalog
function search(terms, user) {
  return new Promise((resolve, reject) => {
    if (typeof user === 'number') {
      user = `CR-ARCHIVE|${user}p`;
    }
    // Run the search on terms
    const url = `http://xdcc.horriblesubs.info/search.php?nick=${user || ''}&t=${terms || ''}`;
    rest.get(url, body => {
      resolve(body
        .toString('utf8')
        .split('\n')
        .map(raw => {
          // Parse JavaScript results
          const regex = /p\.k\[\d+\] = {b:"(.+?)", n:(\d+), s:(\d+), f:"(.+?)"};/;
          const [, user, index, size, filename] = raw.match(regex) || [];

          // extract episode and resolution from filenames
          const { episode, resolution, show } = metaFromFilename(filename);
          return {
            index: parseInt(index),
            episode,
            filename,
            size: parseInt(size),
            resolution,
            showName: show,
            user,
            raw,
          };
        })
        // Filter out things that did not matched the regex
        .filter(l => l.user));
    });
  });
}

// Maps a filename to the config show
function showFromFilename(filename) {
  for(let j = 0; j < config.shows.length; j++) {
    const { start, pattern, name } = config.shows[j];
    if(filename.toLowerCase().match(pattern.toLowerCase())) {
      return config.shows[j];
    }
  }
  return undefined;
}

// Read feed and start downloads
async function readFeed() {
  lastUpdate = Date.now();
<<<<<<< 0340d46d5f58b92dea2f9f45d8d1fe65df3e3b60
  let incompleteFiles = fs.readdirSync(config.settings.incomplete_dir);
=======
  let incompleteFiles = fs.readdirSync(config.settings.incomplete_dir)
    .filter(file => !downloading[file])
>>>>>>> Added progress bars and resume support

  // Search for all episodes
  let queue = [];
  let episodes; 
  const crArchive = search('', config.settings.resolution);
  const ginpachi = search('', 'Ginpachi-Sensei');
  
  try {
    episodes = [].concat(await crArchive, (await ginpachi).filter(s => s.resolution === config.settings.resolution));
  } catch (e) {
    log('Error reading feed');
    return;
  }

  // cannot use .filter as it does not work with async functions
  for(let i = 0; i < episodes.length; i++) {
    const { filename, episode, showName } = episodes[i];
    const isDownloading = !(typeof downloading[filename] === 'undefined' || !downloading[filename]),
      isDownloaded = (await getEpisodes(showName)).includes(episode),
      isIncomplete = incompleteFiles.includes(filename);

    if(isIncomplete && !isDownloading) {
      queue.push(episodes[i]);
      log('Found Incomplete', filename);
    } else {
      let show = showFromFilename(filename);
      if(show) {
        /*
          Only download this if matches these conditions:
              - it is after the specified start episode
              - it has not been previously downloaded
            OR
              - it is an incomplete download
            - it is not being currently downloaded
        */
        const isAfterStart = episode >= (show.start || 0);

        if(isAfterStart && !isDownloaded && !isDownloading) {
          queue.push(episodes[i]);
          log('Found', filename);
        }
      }
    }
  }

  if(queue.length > 0) {
    let targets = [];
    queue.forEach(e => targets.includes(e.user) || targets.push(e.user));

    targets.map(targetName => {
      let queue = queue.filter(e => e.user === targetName).queue.map(s => s.index);
      let queueStr = queue[0];
      for(let i = 1; i < queue.length; i++) {
        let [prev, curr, next] = [queue[i-1], queue[i], queue[i+1]];
        if(prev + 1 === curr && curr + 1 !== next) {
          queueStr += '-' + curr;
        } else if (prev + 1 !== curr) {
          queueStr += ',' + curr;
        }
      }
      client.say(targetName, `xdcc batch ${queueStr}`);
    });
  }
}

let feedInterval;

// Start reading feeds when we get motd
client.on('motd', motd => {
  clearInterval(feedInterval);
  log('Starting Feed');
  readFeed();
  feedInterval = setInterval(readFeed, config.settings.refresh_interval * 60000);
});


client.on('ctcp-privmsg', (from, to, text, type, message) => {
  // Ignore first message
  if(text === 'VERSION')
    return;

  // Only listen to CR-ARCHIVE users
  if(!from.match(/CR-ARCHIVE|(1080|720|480)p/))
    return;

  const args = DCC.parseDCC(text);
  if(args) {
    dcc.client.emit('dcc-' + args.type, from, args, message);
  } else {
    return;
  }

  let {filename, host, port, length} = args;

  if(downloading[filename]) {
    return;
  }

  let {filename, host, port, length} = args;

  if(downloading[filename])
    return;

  if(length) {
    downloadInfo[filename] = args;
  } else {
    host = downloadInfo[filename].host;
    length = downloadInfo[filename].length;
  }

  if(length) {
    downloadInfo[filename] = args;
  } else {
    host = downloadInfo[filename].host;
    length = downloadInfo[filename].length;
  }

  const {complete_dir, incomplete_dir} = config.settings;

  const completeCallback = () => {
    delete downloading[filename];
    log('Completed', filename);

    // Determine if we are auto organizing this file
    let show = showFromFilename(filename);
    const dir = show && show.automove ? `${complete_dir}/${show.name}` : complete_dir;
    mkdir(dir);

    // Move the file from incomplete folder
    fs.rename(
      `${incomplete_dir}/${filename}`,
      `${dir}/${filename}`,
      () => {
        const { show, episode } = metaFromFilename(filename);
        putEpisode(show, episode);
        log('Moved', filename);
      }
    );
  };

  let start = 0;
  if(fs.existsSync(`${incomplete_dir}/${filename}`)) {
    start = fs.statSync(`${incomplete_dir}/${filename}`).size;
    if(start >= length) {
      completeCallback();
      return;
    }
  }

  let bar = multi.newBar(`${filename.replace(/^\[HorribleSubs\]/,'')} [:bar] :percent :etas :elapseds`, {
    total: length || downloadInfo[filename],
    complete: '=',
    incomplete: ' ',
  });

  downloading[filename] = true;
  bar.tick(start);
  
  // Write to the incomplete dir while transferring
  let ws = fs.createWriteStream(`${incomplete_dir}/${filename}`, {flags: 'a+'});

  // Start the transfer
  dcc.acceptFile(from, host, port, filename, length, start, (err, filename, connection) => {
    if (err) {
      console.error('Error Starting', filename, err);
      bars[filename].interrupt('Error Starting');
      delete bars[filename];
      client.notice(from, err);
      return;

    } else {
      // Start transfer
      connection.pipe(ws);

      connection.on('data', data => {
        bar.tick(data.length);
      });

      connection.on('error', err => {
        delete downloading[filename];
        console.error('\nError downloading ' + filename + ' ' + err);
        if(err && err.message.match(/ECONNRESET/)) {
          console.error('Restarting...');
          dcc.client.ctcp(from, 'privmsg', format(resume_template, {
            filename,
            position: fs.statSync(`${incomplete_dir}/${filename}`).size,
          }));
        }
      });

      // Move file and update database upon download completion
      connection.on('end', () => completeCallback());
    }

  });
});

client.on('notice', (source, target, message) => {
  if (message.match(/You have a DCC pending/) && source.match(/CR-ARCHIVE|(1080|720|480)p/)) {
    log('Cancelling pending DCC', message);
    client.say(source, 'xdcc cancel');
  }
});

client.on('error', message => {
    log('error: ', message);
});

function exitHandler({cleanup, exit}, err) {
  console.log(err);
  if (cleanup) {
    console.log('Cleaning up...');
    db.close();
    client.say(`CR-ARCHIVE|${config.settings.resolution}p`, 'xdcc cancel');
  }

  if (exit) {
    setTimeout(process.exit, 500);
  }
}

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup: true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit: true}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit: true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit: true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit: true}));