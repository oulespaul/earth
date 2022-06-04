import ky from 'ky';

export default class Fetcher {
  constructor() {
    this._downloadListeners = [];

    this._progressPerURL = {};
    this._progressPerType = {};
    this._progressOverall = {};

    this._completedURLs = [];

    this._abortControllers = {};
    this._cache = {};
  }

  addDownloadListener(func) {
    this._downloadListeners.push(func);
  }

  async fetch(dataset, date, abortPreviousOfType=true) {
    // __fev2r_api__ is '' by default, can be replaced by env variable
    let url = __fev2r_api__ + dataset.path + date.toISOString() + '.fp16.br';
    let type = dataset.type;

    // workaround for ':' being an illegal character for filenames on Windows,
    if (__using_local_data_files__ && __windows__) {
      url = url.replace(/:/g, '_');
    }

    if (abortPreviousOfType) {
      this.abort(type);
    }

    let cachedResponse = this._cache[url];
    if (cachedResponse) {
      return cachedResponse;
    }

    this._progressPerURL[url] = {
      type,
      transferredBytes: 0,
      totalBytes: dataset.bytesPerFile,
    };
    this._updateProgresses(type);
    this._triggerListeners();

    if (this._abortControllers[type] === undefined) {
      this._abortControllers[type] = new AbortController();
    }

    let data;
    try {
      let res = await ky(url, {
        signal: this._abortControllers[type].signal,
        onDownloadProgress: prog => {
          if (!this._progressPerURL[url]) return;

          this._progressPerURL[url].transferredBytes = prog.transferredBytes;
          this._updateProgresses(type);
          this._triggerListeners();
          this._resetIfComplete();
        },
        timeout: false,
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      let buffer = await res.arrayBuffer();
      this._cache[url] = buffer;
      return buffer;

    } catch (error) {
      delete this._progressPerURL[url];

      this._updateProgresses(type);
      this._triggerListeners();
      this._resetIfComplete();

      if (error.name === 'AbortError') {
        // Do nothing
      } else {
        // Note: Chromium throws TypeErrors instead of AbortErrors if download
        // is partially complete, so ignore this in that case
        console.error('Fetch error:', error);
      }
      return false;
    }
  }

  abort(type) {
    let controller = this._abortControllers[type];
    if (controller) {
      controller.abort();
      this._abortControllers[type] = new AbortController();
    }
    return controller !== undefined;
  }

  _updateProgresses(type) {
    let progs = Object.values(this._progressPerURL)
      .filter(p => p.type === type);
    this._progressPerType[type] = {
      transferredBytes: sumOverProp(progs, 'transferredBytes'),
      totalBytes: sumOverProp(progs, 'totalBytes'),
    };

    progs = Object.values(this._progressPerType);
    this._progressOverall = {
      transferredBytes: sumOverProp(progs, 'transferredBytes'),
      totalBytes: sumOverProp(progs, 'totalBytes'),
    };
  }

  _triggerListeners() {
    for (const listener of this._downloadListeners) {
      listener(
        this._progressOverall, this._progressPerType, this._progressPerURL
      );
    }
  }

  _resetIfComplete() {
    if (this._progressOverall.transferredBytes ===
        this._progressOverall.totalBytes) {
      this._progressPerURL = {};
      this._progressPerType = {};
      this._progressOverall = {};
    }
  }
}

function sumOverProp(array, prop) {
  return array.reduce((acc, curr) => acc + curr[prop], 0);
}
