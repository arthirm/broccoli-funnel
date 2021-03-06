'use strict';

var path = require('path-posix');
var Minimatch = require('minimatch').Minimatch;
var Plugin = require('broccoli-plugin');
var debug = require('debug');
var BlankObject = require('blank-object');
var heimdall = require('heimdalljs');
const isDirectory = require('fs-tree-diff/lib/entry').isDirectory;


function ApplyPatchesSchema() {
  this.mkdir = 0;
  this.rmdir = 0;
  this.unlink = 0;
  this.change = 0;
  this.create = 0;
  this.other = 0;
  this.processed = 0;
  this.linked = 0;
}

function makeDictionary() {
  var cache = new BlankObject();

  cache['_dict'] = null;
  delete cache['_dict'];
  return cache;
}
// copied mostly from node-glob cc @isaacs
function isNotAPattern(pattern) {
  var set = new Minimatch(pattern).set;
  if (set.length > 1) {
    return false;
  }

  for (var j = 0; j < set[0].length; j++) {
    if (typeof set[0][j] !== 'string') {
      return false;
    }
  }

  return true;
}

function isRoot(relativePath) {
  return relativePath === '/' || relativePath === '.' || relativePath === '';
}

Funnel.prototype = Object.create(Plugin.prototype);
Funnel.prototype.constructor = Funnel;
function Funnel(inputNode, _options) {
  if (!(this instanceof Funnel)) { return new Funnel(inputNode, _options); }
  var options = _options || {};
  Plugin.call(this, [inputNode], {
    annotation: options.annotation,
    persistentOutput: true,
    needsCache: false,
    fsFacade: true,
  });

  this._includeFileCache = makeDictionary();
  this._destinationPathCache = makeDictionary();
  this._isRebuild = false;
  // need the original include/exclude passed to create a projection of this.in[0]
  this._origInclude = options.include;
  this._origExclude = options.exclude;

  var keys = Object.keys(options || {});
  for (var i = 0, l = keys.length; i < l; i++) {
    var key = keys[i];
    this[key] = options[key];
  }

  this.destDir = this.destDir || '/';
  this.srcDir = this.srcDir || '/';

  this.count = 0;

  if (this.files && typeof this.files === 'function') {
    // Save dynamic files func as a different variable and let the rest of the code
    // still assume that this.files is always an array.
    this._dynamicFilesFunc = this.files;
    delete this.files;
  } else if (this.files && !Array.isArray(this.files)) {
    throw new Error('Invalid files option, it must be an array or function (that returns an array).');
  }

  if ((this.files || this._dynamicFilesFunc) && (this.include || this.exclude)) {
    throw new Error('Cannot pass files option (array or function) and a include/exlude filter. You can have one or the other');
  }

  if (this.files) {
    if (this.files.filter(isNotAPattern).length !== this.files.length) {
      console.warn('broccoli-funnel does not support `files:` option with globs, please use `include:` instead');
      this.include = this.files;
      this.files = undefined;
    }
  }

  this._instantiatedStack = (new Error()).stack;
  this._buildStart = undefined;
}

Funnel.prototype._debugName = function() {
  return this.description || this._annotation || this.name || this.constructor.name;
};

Funnel.prototype._debug = function(message) {
  debug('broccoli-funnel:' + (this._debugName())).apply(null, arguments);
};

Funnel.prototype.__supportsFSFacade = true;

Funnel.prototype.shouldLinkRoots = function() {
  return !this.files && !this._dynamicFilesFunc && !this.include && !this.exclude && !this.getDestinationPath;
};

Funnel.prototype.build = function() {
  this._buildStart = new Date();
  this.destPath = this.out.resolvePath(this.destDir);

  if (!this._projectedIn) {
      this._projectedIn = this.in[0].filtered({
        cwd: this.srcDir,
        files: this.files,
        include: this._origInclude,
        exclude: this._origExclude,
      });
  }

  if (this._dynamicFilesFunc) {
    this._projectedIn.files = this._dynamicFilesFunc();
  }

  let linkedRoots = false;
  // TODO: root linking is basically a projection
  // we already support srcDir via `chdir`.  Once we have support for globbing
  // we will handle the `this.include` and `this.exclude` cases, after which we
  // will never "link roots" within funnel; root linking will merely mean
  // projecting.  This does mean that we will `this.out` to be a projection of
  // `this.in`, so we may need to be able to modify `this.out`.
  if (this.shouldLinkRoots()) {
    linkedRoots = true;

    /**
     * We want to link the roots of these directories, but there are a few
     * edge cases we must account for.
     *
     * 1. It's possible that the original input doesn't actually exist.
     * 2. It's possible that the output symlink has been broken.
     * 3. We need slightly different behavior on rebuilds.
     *
     * Behavior has been modified to always having an `else` clause so that
     * the code is forced to account for all scenarios. Not accounting for
     * all scenarios made it possible for initial builds to succeed without
     * specifying `this.allowEmpty`.
     */
    
    const inputPathExists = this._projectedIn.existsSync('');
    // Doesn't count as a rebuild if the output is empty or not a projection.  (No links.)
    this._isRebuild = this._isRebuild && (this.out.parent || this.out.size);

    if (this._isRebuild) {

      this._prevEntries = this._entries;

      if (inputPathExists) {
        // Already works because of symlinks. Do nothing.
      } else if (this.allowEmpty) {
        // Make sure we're safely using a new outputPath since we were previously symlinked:
        this.out.undoRootSymlink();
        this.out.emptySync('');

        // Create a new empty folder:
        this.out.mkdirpSync(this.destDir);
      } else { // this._isRebuild && !inputPathExists && !this.allowEmpty
        // TODO: shouldn't this throw an error?

        // Need to remove it on the rebuild.
        // Can blindly remove a symlink if path exists.
        this.out.undoRootSymlink();
        this.out.emptySync('');
      }
    } else { // Not a rebuild.
      if (inputPathExists) {
        symlink(this._projectedIn, '', this.out, this.destDir);
      } else if (!inputPathExists && this.allowEmpty) {
        // Can't symlink nothing, so make an empty folder at `destPath`:
        if (!isRoot(this.destDir)) {
          this.out.mkdirpSync(this.destDir);
        }
      } else { // !this._isRebuild && !inputPathExists && !this.allowEmpty
        throw new Error('You specified a `"srcDir": ' + this.srcDir + '` which does not exist and did not specify `"allowEmpty": true`.');
      }
    }

    this._isRebuild = true;
  } else {
    this.processFilters('.');
  }

  this._debug('build, %o', {
    in: new Date() - this._buildStart + 'ms',
    linkedRoots: linkedRoots,
    inputPath: this._projectedIn.root,
    destPath: this.destPath
  });
};

function ensureRelative(string) {
  if (string.charAt(0) === '/') {
    return string.substring(1);
  }
  return string;
}

Funnel.prototype._processPatches = function(patches) {
  let dirList = new Set();

  for (let i = 0; i < patches.length; ++i) {
    let patch = patches[i];
    let operation = patch[0];
  
    const outputRelativePath = this.lookupDestinationPath(patch[2]);
    this.outputToInputMappings[outputRelativePath] = patch[2].relativePath;
    patch[1] = outputRelativePath;
    patch[2].relativePath = outputRelativePath;

    if (operation === 'mkdir' || operation === 'mkdirp') {
      dirList.add(chompPathSep(patch[1]));
    }

    // TODO: Add tests for this
    /* Here, we are adding entries to mkdirp paths that lookupDestinationPath adds to the entry.
     eg. entry.relativePath = a.js
     this.lookupDestinationPath(entry) returns c/b/a.js
     we need to mkdirp c/b
     */
    const parentRelativePath = chompPathSep(path.dirname(outputRelativePath));

    if (parentRelativePath !== '.' && !dirList.has(parentRelativePath)) {
        let setOperation;
        if(dirList.has(parentRelativePath.substring(0, parentRelativePath.lastIndexOf('/'))) || parentRelativePath.split('/').length  === 1) {
          setOperation = 'mkdir';
        } else {
          setOperation = 'mkdirp';
        }

        dirList.add(parentRelativePath);
        patches.splice.apply(patches, [i,0].concat([[
          setOperation,
          parentRelativePath,
          {
            mode: 16877,
            relativePath: parentRelativePath,
            size: 0,
            mtime: Date.now(),
            checksum: null,
          },
        ]]));
        i++;
      }
  }

  return patches;
};

// TODO: inputPath is always '.' now because if we have srcDir this is handled
// via this._projectedIn being a projection
Funnel.prototype.processFilters = function(inputPath) {
  let instrumentation = heimdall.start('derivePatches - broccoli-funnel');

  this.outputToInputMappings = {}; // we allow users to rename files

  // utilize change tracking from this._projectedIn
  const patches = this._processPatches(this._projectedIn.changes());

  console.log(`----------------patches from ${this._name + (this._annotation != null ? ' (' + this._annotation + ')' : '')}`);
  patches.forEach(patch => {
    console.log(patch[0] + ' ' + chompPathSep(patch[1]));
  });

  instrumentation.stats.patches = patches.length;
  instrumentation.stop();
  instrumentation = heimdall.start('applyPatch  - broccoli-funnel', ApplyPatchesSchema);

  patches.forEach(function(entry) {
    this._applyPatch(entry, inputPath, instrumentation.stats);
  }, this);

  instrumentation.stop();
};

function chompPathSep(path) {
  // strip trailing path.sep (but both seps on posix and win32);
  return path.replace(/(\/|\\)$/, '');
}

Funnel.prototype._applyPatch = function applyPatch(entry, inputPath, stats) {
  var outputToInput = this.outputToInputMappings;
  var operation = entry[0];
  var outputRelative = entry[1];

  if (!outputRelative) {
    // broccoli itself maintains the roots, we can skip any operation on them
    return;
  }

  this._debug('%s %s', operation, outputRelative);

  switch (operation) {
    case 'unlink':
      stats.unlink++;
      this.out.unlinkSync(outputRelative);
      break;
    case 'rmdir':
      stats.rmdir++;
      this.out.rmdirSync(outputRelative);
      break;
    case 'mkdir':
      stats.mkdir++;
      this.out.mkdirSync(outputRelative);
      break;
    case 'mkdirp':
      // Not a "real" change operation, but created by _processPatches as a shortcut.
      stats.mkdirp++;
      this.out.mkdirpSync(outputRelative);
      break;
    case 'change':
      stats.change++;
      /* falls through */
    case 'create':
      if (operation === 'create') {
        stats.create++;
      }

      let inputRelative = outputToInput[outputRelative];
      if (inputRelative === undefined) {
        inputRelative = outputToInput['/' + outputRelative] || outputToInput[this.destDir + '/' + outputRelative] || '';
      }
      this.processFile(inputPath + '/' + inputRelative, outputRelative);

      break;
    default: throw new Error('Unknown operation: ' + operation);
  }
};

Funnel.prototype.lookupDestinationPath = function(entry) {
  if (this._destinationPathCache[entry.relativePath] !== undefined) {
    return this._destinationPathCache[entry.relativePath];
  }

  // the destDir is absolute to prevent '..' above the output dir
  if (this.getDestinationPath && !isDirectory(entry)) {
    return this._destinationPathCache[entry.relativePath] = ensureRelative(path.join(this.destDir, this.getDestinationPath(entry.relativePath)));
  }

  return this._destinationPathCache[entry.relativePath] = ensureRelative(path.join(this.destDir, entry.relativePath));
};

Funnel.prototype.processFile = function(sourcePath, destPath) {
  symlink(this._projectedIn, sourcePath, this.out, destPath);
};

function symlink(sourceTree, sourcePath, destTree, destPath) {
  const parentPath = path.dirname(destPath);

  // Ensure the parent directory exists.
  if (!destTree.existsSync(parentPath)) {
    destTree.mkdirpSync(parentPath);
  }

  // Ensure the target file *doesn't* exist.
  if (!isRoot(destPath) && destTree.existsSync(destPath)) {
    destTree.unlinkSync(destPath);
  }
  destTree.symlinkSyncFromEntry(sourceTree, sourcePath, destPath);
}

module.exports = Funnel;