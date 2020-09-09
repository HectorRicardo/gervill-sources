const https = require('https');
const fs = require('fs').promises;
const strip = require('strip-comments');

// const exceptions = require('./exceptions.json');
const skipclasses = new Set(require('./skipclasses.json'));

const BASE_URL = 'https://hg.openjdk.java.net/jdk8u/jdk8u/jdk/raw-file/tip/src/share/classes';

/**
 * Returns the contents of the file located at the given path of the OpenJDK repo.
 *
 * @param {string} path - the path of the file in the OpenJDK Mercurial repository
 */
function getFileContentsAsString(path) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE_URL}/${path}`, resp => {
      let data = '';  
      resp
        .on('data', (chunk) => {
          data += chunk;
        })
        .on('end', () => {
          resolve(data);
        });
    }).on('error', reject);
  });
}

/**
 * Gets the contents description file of the directory located at path in
 * the OpenJDK repo.
 * 
 * @param {string} path - the path of the directory description file in the
 * OpenJDK Mercurial repository.
 * @returns {Promise<string>} the contents of the directory description file.
 */
async function getFileListing(path) {
  const isDirectory = entry => entry[0] === 'd';
  return (await getFileContentsAsString(path))
    .split('\n')
    .filter(entry => entry.trim() !== '' && (entry.endsWith('.java') || isDirectory(entry)))
    .map(entry => ({
      isDirectory: isDirectory(entry),
      name: entry.match(/\S+$/g)[0],
    }));
}

/**
 * Retrieves the contents of the file located at the given path of the OpenJDK repo,
 * and save it to the local system in the same path.
 *
 * @param {string} path - the path of the file in the OpenJDK Mercurial repository.
 * @param {makeCopies} - if true, will make copies of the file
 * (adding gervill prefix, removing comments for comparison, etc.)
 */
function fetchFile(path, makeCopies) {
  const [directory, filename] = path.split(/\/(?=\w+.java)/);
  return fetchFileAux(directory, filename, makeCopies);
}

const fidelityRegex = /\}\s*$/;

async function fetchFileAux(directory, filename, makeCopies) {
  await fs.mkdir(`original/${directory}`, { recursive: true });

  const path = `${directory}/${filename}`;

  console.log(`downloading ${path}`);
  let originalContent = await getFileContentsAsString(path);
  /*
  while (!fidelityRegex.test(originalContent)) {
    console.log(`Re-download ${path}`);
    originalContent = await getFileContentsAsString(path);
  }
  */
  console.log(`saving      ${path}`);
  await fs.writeFile(`original/${path}`, originalContent);

  if (makeCopies) {
    await createFileCopies(directory, filename, originalContent);
  }
}

/**
 * Retrieves the contents of all the files in the directory located
 * at the given path of the OpenJDK repo, and save it to the local system 
 * in the same path.
 *
 * @param {string} path - the path of the directory in the OpenJDK Mercurial repository
 * whose files will be fetched.
 * @param {makeCopies} - if true, will make copies of the file
 * (adding gervill prefix, removing comments for comparison, etc.)
 */
function fetchDirectory(path, makeCopies) {
  return fetchDirectoryAux(path.replace(/\/$/, ''), makeCopies);
}

async function fetchDirectoryAux(directory, makeCopies) {
  const fileListing = await getFileListing(directory);
  for (const { name, isDirectory } of fileListing) {
    const fileOrDirName = `${directory}/${name}`;
    if (isDirectory) {
      await fetchDirectoryAux(fileOrDirName, makeCopies);
    } else if (!skipclasses.has(fileOrDirName)) {
      await fetchFileAux(directory, name, makeCopies);
    }
  }
}


/*************************CREATE FILE COPIES PART*********************/

/**
 * Make necessary copies of the files.
 * 1) Add the gervill prefix to the packages and imports.
 * 2) Remove packages and imports from the original content to compare (base).
 * 3) Remove packages and imports from result of point 1) to compare (new changes).
 * 
 * @param {string} directory - the directory where the file is located
 * @param {string} filename - the name of the file to make copies of.
 * @param {string} originalContent - the original content of the file, as retrieved from the repo.
 */
function createCopiesOfFiles() {
  return createCopiesOfFilesInDir('');
}

function createCopiesOfSingleFile(path) {
  const [directory, filename] = path.split(/\/(?=\w+.java)/);
  return createCopiesOfSingleFileAux(directory, filename);
}

async function createCopiesOfSingleFileAux(directory, filename) {
  const originalContent = await fs.readFile(`original/${directory}/${filename}`, 'utf-8');
  await createFileCopies(directory, filename, originalContent);
}

async function createCopiesOfFilesInDir(directory) {
  const dir = await fs.opendir(`original/${directory}`);
  for await (const dirent of dir) {
    if (dirent.isDirectory()) {
      await createCopiesOfFilesInDir(`${directory}/${dirent.name}`);
    } else {
      await createCopiesOfSingleFileAux(directory, dirent.name);
    }
  }
};

// ---------- Regular expressions needed for the copies -----------

const gervillSeparatorRegex = /\.|\/|\\|\\\\/;

let id = 1;
function createGervillRegexSource(path) {
  const [param1, ...params] = path.split('.');
  if (!params.length) {
    return param1;
  }
  return `${param1}(${gervillSeparatorRegex.source})${params.join(`\\${id++}`)}`;
}

const packages = [
  'javax.sound',
  'com.sun.media.sound',
];

const gervillRegex = new RegExp(packages.map(createGervillRegexSource).join('|'), 'g');

const packageAndImportsRegex = /^[\s\S]*package\s+\S+;\s*(?:import\s+\S+;\s*)*/;
//const commentsRegex = /(?:\/\*(?:[^*]|[\r\n]|(?:\*+(?:[^*/]|[\r\n])))*\*+\/)|(?:\/\/.*)/;

const commentsLinkRegex = /\{@link([^{}]+)\}/;
const throwsOrSeeRegex = /(?:@(throws|see))/;

const finalCommentsLinkRegex = new RegExp(`${commentsLinkRegex.source}|${throwsOrSeeRegex.source}`, 'g');

// const exceptionsRegex = new RegExp(`throw new (?:${exceptions.join('|')})`, 'g');

function cleanForComparison(contents) {
  return strip(contents.replace(packageAndImportsRegex, ''));
}

// ----------- End regular expressions ------------

/**
 * The shared function used by both the fetching function (called when makeCopies is true)
 * and the copy function.
 *
 * @param {string} directory - the directory where the file is located
 * @param {string} filename - the name of the file to make copies of.
 * @param {string} originalContent - the original content of the file, as retrieved from the repo.
 */
async function createFileCopies(directory, filename, originalContent) {
  await fs.mkdir(`../gervill-control/output/src/gervill/${directory}`, { recursive: true });
  await fs.mkdir(`../gervill-control/comp/original-comp/${directory}`, { recursive: true });
  await fs.mkdir(`../gervill-control/comp/gervill-comp/${directory}`, { recursive: true });

  const newFileContent = originalContent.replace(
      gervillRegex,
      (match, ...rest) => {
        //return `gervill${match.match(separatorRegex)[0]}${match}`;
        for (let i = 0; i < packages.length; i++) {
          if (rest[i]) {
            return `gervill${rest[i]}${match}`;
          }
        }
      },
    ).replace(
      finalCommentsLinkRegex,
      (_, textThatWillStay1, textThatWillStay2) => coalesce(textThatWillStay1, textThatWillStay2)
    ); //.replace(exceptionsRegex, 'throw new RuntimeException');

  const path = `${directory}/${filename}`;
  await fs.writeFile(`../gervill-control/output/src/gervill/${path}`, newFileContent);
  await fs.writeFile(`../gervill-control/comp/original-comp/${path}`, cleanForComparison(originalContent));
  await fs.writeFile(`../gervill-control/comp/gervill-comp/${path}`, cleanForComparison(newFileContent));
}

/*********************END FILE COPY CREATION PART*******************************/

(async function main() {
  const flag = process.argv[2];
  switch (flag) {
    case '-d': // download files
      await fetchDirectory('javax/sound/midi', false);
      await fetchDirectory('javax/sound/sampled', false);
      await fetchDirectory('com/sun/media/sound', false);
      break;
    case '-c': // copy files
      await createCopiesOfFiles();
      break;
    default:
      throw new Error(`Unrecognized flag ${flag}. Only flags -d and -c are available.`);
  }
})();

/************* HELPERS *************/
function coalesce(a, b) {
  return a == null ? b : a;
}
