const irc = require('irc');
const DCC = require('irc-dcc');
const fs = require('fs');
const { Client } = require('node-rest-client');
const yaml = require('js-yaml');
const sqlite3 = require('sqlite3').verbose();
 
let rest = new Client();

//  Loading the config out of the config.yml file
let config;
try {
  config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));
} catch (e) {
  console.error('Missing config.yml. Please reference config.yml.default');
  process.exit(1);
}

let client = new irc.Client('irc.rizon.net', config.settings.bot_name, {
    channels: [],
});
let dcc = new DCC(client);

let downloading = {};

// Create a directory if it doesn't exist
function mkdir(dir) {
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
  }
}

// Create our config directories
mkdir(config.settings.complete_dir);
mkdir(config.settings.incomplete_dir);
mkdir(config.settings.data_dir);

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
let showMap = {};

// Read feed and start downloads
async function readFeed() {
  lastUpdate = Date.now();
  // Search for all episodes
  let queue = [];
  const crArchive = search('', config.settings.resolution);
  const ginpachi = search('', 'Ginpachi-Sensei');
  let episodes = [].concat(await crArchive, (await ginpachi).filter(s => s.resolution === config.settings.resolution));

  // cannot use .filter as it does not work with async functions
  for(let i = 0; i < episodes.length; i++) {
    const { filename, episode, showName } = episodes[i];

    for(let j = 0; j < config.shows.length; j++) {
      const { start, pattern, name } = config.shows[j];
      if(filename.toLowerCase().match(pattern.toLowerCase())) {
        showMap[filename] = config.shows[j];

        /*
          Only download this if matches these conditions:
            - it is after the specified start episode
            - it has not been previously downloaded
            - it is not being currently downloaded
        */
        if(episode >= (start || 0) &&
          !(await getEpisodes(showName)).includes(episode) &&
          (typeof downloading[filename] === 'undefined' || !downloading[filename])) {
          log('Found', filename);
          queue.push(episodes[i]);
          break;
        }
      }
    }
  }

  if(episodes.length > 0) {
    client.say(
      `CR-ARCHIVE|${config.settings.resolution}p`,
      `xdcc batch ${queue.map(s => s.index).join(',')}`
    );
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

  const {filename, host, port, length} = DCC.parseDCC(text);
  if(!filename)
    return;

  const {complete_dir, incomplete_dir} = config.settings;

  // Write to the incomplete dir while transferring
  let ws = fs.createWriteStream(`${incomplete_dir}/${filename}`);

  log('Queued', filename);
  // Start the transfer
  dcc.acceptFile(from, host, port, filename, length, (err, filename, connection) => {
    if (err) {
      console.error('Error Starting', filename, err);
      client.notice(from, err);
      return;

    } else {
      log('Connected', filename);

      // Start transfer
      connection.pipe(ws);
      downloading[filename] = true;

      connection.on('error', (err) => {
        delete downloading[filename];
        delete showMap[filename];
        log('Error Downloading', filename, err);
      });

      // Move file and update database upon download completion
      connection.on('end', () => {
        delete downloading[filename];
        log('Completed', filename);

        // Determine if we are auto organizing this file
        const dir = showMap[filename].automove ? `${complete_dir}/${showMap[filename].name}` : complete_dir;
        mkdir(dir);

        delete showMap[filename];

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
      });
    }

  });
});

client.on('notice', (source, target, message) => {
  if (message.match(/You have a DCC pending/) && source.match(/CR-ARCHIVE|(1080|720|480)p/)) {
    log('Cancelling pending DCC');
    client.say(source, 'xdcc cancel');
  }
});

client.on('error', message => {
    log('error: ', message);
});

function exitHandler({cleanup, exit}, err) {
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