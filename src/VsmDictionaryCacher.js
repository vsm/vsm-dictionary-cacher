/*
Specification:
  see 'README.md'.


Terminology:

- 'query' = a request to the real, underlying data store.
- 'identical call/query' = a request for the same search-string and options-obj.
- 'call' = a request to this subclass's `getMatchesForString()`, which can
    either return a result that is found in the cache, or make a real query.

- 'cache key' = a string that uniquely represents a search-string + options-obj.
- 'cache item' = an object that stores the result that a query returned,
    together with a timestamp.

- 'cacheMO...':
  we use 'cacheMO' (instead of just 'cache') in several variable names,
  to clarify that it's a cache that concerns *match-objects*. This helps avoid
  potential naming conflicts with other caches in future code or subclasses.

*/


module.exports = function VsmDictionaryCacher(VsmDictionary, cacheOptions) {

  cacheOptions = cacheOptions || {};


  return class VsmDictionaryCached extends VsmDictionary {

    constructor(options) {
      super(options);

      this.cacheMaxItems = cacheOptions.maxItems || 0;
      this.cacheMaxAge   = cacheOptions.maxAge   || 0;
      this.cacheMOPredictEmpties =
        (typeof cacheOptions.predictEmpties) === 'undefined' ? true:
        !!cacheOptions.predictEmpties;

      /**
       * This stores the literal result of successful previous string-queries
       * for retrieving Match-Objects.
       * - - Each cache-item has the form: `{ value:, lastAccessed: }`,
       *   - and is accessed by a key from `_createCacheMOKey()`.
       * - A key represents a unique query. It represents the string+options
       *   arguments of a `getMatchesForString()` call.
       */
      this.cacheMO = {};

      /**
       * Reference to a running timer that causes the whole cache
       * to be automatically emptied, `maxAge` after the last access to it.
       */
      this.cacheMOClearTimer;

      /**
       * Used for handling concurrent identical queries.
       * E.g.:  `{ cacheKeyX : [some2ndCallsCallback], cacheKeyY : [] }`.
       * - The cache-keys are the same as in `cacheMO`.
       * - To have a key/value here, means that a query is still ongoing for the
       *   key. So here, `cacheKeyX/Y` have a still-ongoing/unanswered query.
       * - For `cacheKeyX`, there is a second call also waiting for its result;
       *   we will give that call the result of the same query as well.
       * - But no other call is waiting for `cacheKeyY`'s result right now.
       */
      this.cacheMOQueryQueue = {};

      /**
       * For each encountered options-object, this holds a List of strings
       * for which a previous query returned an empty list of match-objects.
       * E.g.:  `{ 'optionsObj1-as-JSON': [str, ...], 'opt2': [],  ... }`.
       */
      this.cacheMOEmpties = {};
    }



    // --- 1) Override `getMatchesForString()` of the parent class: ---

    getMatchesForString(str, options, cb) {
      // Note: we ensure that the call to cb() is always truly asynchronous
      //       (according to VsmDictionary's specification), i.e. it gets called
      //       back on the next event-loop).
      //       Therefore we wrap calls to `cb` for which we do not launch a real
      //       query (e.g. cache-hits) in `callAsync`.

      this._restartCacheMOClearTimer();

      // First search the result in the cache.
      var key = this._createCacheMOKey(str, options);
      this._getCacheMOItem(key, (err, value, mayQuery = true) => {

        // If we got the result from the cache or from a concurrent query, or
        // if we tried to get it from a concurrent query but it errored:
        // then return what we got.
        if ( (!err && value) || (err && !mayQuery) ) {
          return callAsync(cb, err, value);
        }

        // If a shorter string (for same options) already returned no matches,
        // then we can also return 'no matches' now.
        if (this._getCacheMOEmptiesPrediction(str, options)) {
          return callAsync(cb, null, { items: [] });
        }

        // Delegate the query to the parent class, as no result was found here.
        this.cacheMOQueryQueue[key] = []; // Signal for: a real query is ongoing.

        super.getMatchesForString(str, options, (err, res) => {
          this._updateCacheMOEmpties(str, options, err, res);
          this._setCacheMOItem(key, err, res);

          // Forward query results to the caller.
          // Note: we may assume (according to VsmDictionary's spec)
          //       that we are already inside a truly-asynchronously
          //       called callback. So `callAsync(cb, ...)` is not needed here.
          cb(err, res);
        });

      });
    }



    // --- 2) One public and a private function for cache-clearing,
    //        added to this subclass: ---

    clearCache() {
      this.cacheMO = {};
      this.cacheMOEmpties = {};
    }



    /**
     * If applicable, restarts a timer for automatically clearing the cache,
     * at `cacheMaxAge` milliseconds after any last access to the cache.
     */
    _restartCacheMOClearTimer() {
      if (this.cacheMaxAge) {
        clearTimeout(this.cacheMOClearTimer);  // Stop it if running already.
        this.cacheMOClearTimer =               // Start or restart it now.
          setTimeout(this.clearCache.bind(this), this.cacheMaxAge);
      }
    }



    // --- 3) Private functions for normal cache handling: ---

    /**
     * Makes a cache-key based on the arguments given to `getMatchesForString()`.
     */
    _createCacheMOKey(str, options) {
      return str + JSON.stringify(options || {});
    }


    /**
     * Returns a cached result, or `null` if not found.
     * - This function is asynchronous, only so that it can wait, if needed,
     *   for the result of a ongoing query for the same string + options-object.
     * - Callback `)` has arguments: `(error, result, [mayQuery = true])`.
     */
    _getCacheMOItem(key, cb) {
      // If an identical query is ongoing, queue and wait for its result.
      if (this._addToMOQueryQueue(key, cb))  return;

      // Get it from cache.
      var item = this.cacheMO[key];
      if (!item)  return cb(null, null);

      // Only use a cache item if it didn't expire.
      var now = getNowTime();
      if (this.cacheMaxAge  &&  now - item.lastAccessed > this.cacheMaxAge) {
        delete this.cacheMO[key];  // If a req. item expired, evict it from cache.
        return cb(null, null);
      }

      // Reset item expiration time, and use it.
      item.lastAccessed = now;
      cb(null, item.value);
    }


    /**
     * Adds or updates a cache item, if a query did not result in an error.
     * Also deals with resolving any callbacks of queued, identical calls.
     */
    _setCacheMOItem(key, err, value) {
      if (!err) {
        // Add a cache item.
        this.cacheMO[key] = { value, lastAccessed: getNowTime() };

        // If the cache grew too large, evict the oldest item.
        if (this.cacheMaxItems &&
            Object.keys(this.cacheMO).length > this.cacheMaxItems) {
          deleteOldestItem(this.cacheMO);
        }
      }

      // Share the result with all queued, identical calls.
      this._resolveMOQueryQueue(key, err, value);
    }



    // --- 4) Private functions for making that concurrent requests
    //        piggy-back on the first one call, and use its results: ---

    /**
     * Only if a (match-object-)query for `key` is already running, then we
     * queue `cb`, so that it gets called when that ongoing query finishes.
     * - Returns true if such a query is ongoing, and thus the caller
     *   has to wait for the results.
     * - Returns false if no such query us ongoing, and thus the caller
     *   can start such a query now.
     */
    _addToMOQueryQueue(key, cb) {
      if (this.cacheMOQueryQueue[key]) {
        this.cacheMOQueryQueue[key].push(cb);
        return true;
      }
      return false;
    }


    /**
     * If any identical calls' queued callbacks were waiting for the query
     * (for `key`) to finish (which just finished before we came here), then this
     * function makes those callbacks return the same result as the query did.
     * + But if the query returned an error, then it makes the callbacks forward
     *   that error, plus a signal (arg. 3 `mayQuery' = false) so that
     *   `getMatchesForString()` will not launch a new query after this.
     */
    _resolveMOQueryQueue(key, err, value) {
      do {
        var cb = this.cacheMOQueryQueue[key].pop();
        if (cb) {
          // We wrap this in an Immediately-Invoked-Function-Expression, to give
          // the function called by `setTimeout` a fixed reference to one
          // specific `cb`. (Because `cb` changes with every `while`-iteration).
          (() => {
            var myCb = cb;
            setTimeout(() => { myCb(err, value, false); }, 1);
          }) ();
        }
      }
      while (cb);

      delete this.cacheMOQueryQueue[key];  // Signal for: the query is now over.
    }



    // --- 5) Private functions for predicting empty results: ---

    /**
     * Makes a cache-key for `cacheMOEmpties`,
     * based on the options-object given to `getMatchesForString()`.
     */
    _createCacheMOEmptiesKey(options) {
      return JSON.stringify(options || {});
    }


    /**
     * If the response `(err, res)` of a query gave an empty list of
     * match-objects, then adds the search-string to `cacheMOEmpties`.
     * + For `cacheMOEmpties`'s data structure, see comment in the constructor.
     */
    _updateCacheMOEmpties(str, options, err, res) {
      if (this.cacheMOPredictEmpties &&
          !err && res && res.items && !res.items.length) {

        var key = this._createCacheMOEmptiesKey(options);
        var list = this.cacheMOEmpties[key];
        if (!list)  list = this.cacheMOEmpties[key] = [];  // Initialize list.

        if (list.indexOf(str) == -1)  list.push(str);  // Add, but no duplicates.
      }
    }


    /**
     * Given a search-string and options-object, tells if that query will return
     * an empty list of match-objects (so we can skip running that query).
     * - Returns: `true` if it will be empty too, `false` if perhaps not.
     */
    _getCacheMOEmptiesPrediction(str, options) {
      if (!this.cacheMOPredictEmpties)  return false;

      var key = this._createCacheMOEmptiesKey(options);
      var list = this.cacheMOEmpties[key];

      // If `str` starts with any of the strings in this list, return `true`.
      return list  &&  list.findIndex(s => str.startsWith(s)) >= 0;
    }

  };
}




// --- Some helper functions.

function callAsync(f, ...args) {
  setTimeout(() => f(...args), 0);
}


function getNowTime() {
  return (new Date()).getTime();
}


/**
 * Deletes the least recently accessed item in a `cache` which
 * has the format: `{ { value:, lastAccessed: }, ... }`.
 */
function deleteOldestItem(cache) {
  var keys = Object.keys(cache);
  var oldestTime = Number.POSITIVE_INFINITY;
  var index = -1;
  for (var i = 0;  i < keys.length;  i++) {
    var x = cache[keys[i]].lastAccessed;
    if (x < oldestTime) {
      oldestTime = x;
      index = i;
    }
  }
  delete cache[ keys[index] ];
}
