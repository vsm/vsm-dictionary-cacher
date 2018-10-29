/*
Specification:
  see 'README.md'.

Terminology:
- 'query' = a request to the real, underlying data store.
- 'call/request' = a request to this subclass's get-function (e.g. to the
    caching-class's `getMatchesForString()`), which can either return a result
    that is found in the cache, or that comes from making a real query.

- 'cacheMO...': variables related to the cache for string-match-objects.
- 'cacheRT...':  "  for refTerms.
- 'cacheDI...':  "  for dictInfos.
- 'cacheFT...':  "  for fixedTerms.

+ For cacheMO-handling:
  - 'identical call/query' = a request (for match-objects) with the same
                             arguments (e.g. str+options).
  - 'cache item' = Object that stores the result that a query returned,
      together with a timestamp.
  - 'cache key' = unique String for accessing such an object.

+ For cacheDI-handling:
  - 'req-for-all' = a request for all dictInfos.
  - 'req-for-IDs' = a based on a list of dictIDs, via `options.filter.id[]`.

*/
const { callAsync, getNowTime, deleteOldestCacheItem }
  = require('./helpers/util');



module.exports = function VsmDictionaryCacher(VsmDictionary, cacheOptions) {

  cacheOptions = cacheOptions || {};


  return class VsmDictionaryCached extends VsmDictionary {

    constructor(options) {
      super(options);

      this.cacheMaxItems = cacheOptions.maxItems || 0;
      this.cacheMOPredictEmpties =
        cacheOptions.predictEmpties === undefined ||
        !!cacheOptions.predictEmpties;


      // --- Data for caching of MATCH-OBJECTS.
      /**
       * Match-Objects cache. This stores the literal result of successful
       * previous queries by `getMatchesForString()`.
       * - Each cache-item has the form: `{ value: .., lastAccessed: .. }`;
       * - and is accessed by a key from `_createCacheMOKey()`,
       *   which builts it from the string+options args of a `getMatches...()`
       *   call. So the key represents a unique query.
       */
      this.cacheMO = {};

      /**
       * Used for handling concurrent identical calls to `getMatchesForString()`.
       * E.g.:  `{ cacheKeyX : [cb1, cb2, ...], cacheKeyY : [cb1] }`.
       * - Cache-keys are like for `cacheMO` (i.e. searchStr+options).
       * - A cache-item is an array of callbacks that must be notified when
       *   the result of a query comes in. This includes the `cb` of the
       *   original call that created the queue.
       */
      this.cacheMOQueue = {};

      /**
       * For each encountered options-object, this holds a List of strings
       * for which a previous query returned an empty list of match-objects.
       * E.g.:  `{ 'optionsObj1-as-JSON': [str, ...], 'opt2': [],  ... }`.
       */
      this.cacheMOEmpties = {};


      // --- Data for caching of REFTERMS.
      /**
       * At a first call to getRefTerms, this becomes an array of all the
       * refTerms from the dictionary.
       * It is `false` before this first call, `true` when a query to fill it
       * was launched but has not returned results yet, and an Array when done.
       */
      this.cacheRT = false;

      /**
       * Used for queueing calls to get refTerms, while the initial query
       * to fill `cacheRT` hasn't answered yet.
       */
      this.cacheRTQueue = [];


      // --- Data for caching of DICTINFOS.
      /**
       * DictInfo-objects cache.
       * - All dictInfos received from any query are stored here, by dictID key.
       * - For dictInfos that it expected but did not receive, and which are
       *   thus non-existent, it stores a `'-'`.
       * E.g.: `{ dictID1: {dictID: dictID1, name: ..}, dictID2: '-', .. }`.
       */
      this.cacheDI = {};

      /**
       * This stores all dictIDs for which a query has been launched, and for
       * which results have not arrived yet, indexed by dictID-key.
       * E.g.: `{ dictID1: true, dictID5: true, ... }`.
       */
      this.cacheDIQueried = {};

      /**
       * A list of "queue-objects".
       * These are info-objects about still-ongoing getDictInfo()-queries. Only
       * when all query results they depend on arrived, will their callback `cb`
       * be called with the assembled result (i.e. a list of dictInfos).
       * - E.g.:
       * `[ { items: [            // A being-built `res.items` object, with e.g.:
       *        { id: .., _q: false }, // - a dictInfo that needs to be queried,
       *        { id: .., _q: true  }, // - one that was queried; is now pending,
       *        { id: .., name: 'A' }, // - a dictInfo that we got already.
       *      ],
       *      options: {...},          // The request's options e.g. for sorting.
       *      cb },                    // The request's `cb`.
       *
       *    { items: .., options:.., cb.. },  // More queue-objects.
       *    ...                               // " .
       *  ]`
       * - Note: as soon as it is known that a dictID is non-existent, its
       *         placeholder-dictInfo gets removed from `items`.
       * + Special case: for getDictInfo()-calls to get all dictInfos (i.e. with
       *   no `options.filter`), the queue-object's `items` is set to `true`.
       */
      this.cacheDIQueue = [];

      /**
       * Tells if a request for all dictInfo-objs (i.e. with no `options.filter`)
       * has been made:  0 = never made;  0.5 = queried but awaiting answer;
       * 1 = received all, so `cacheDI` contains all existing dictInfos.
       */
      this.cacheDIGotAll = 0;


      // --- Data for caching of FIXEDTERMS.
      /**
       * - This stores all idts (conceptID+termString-s) for which a query has
       *   been launched, but results did not arrive yet, indexed by
       *   "fixedTerm-cacheKey" (given by `VsmDictionary._idtToFTCacheKey()`).
       * - Also, stores fixedTerms that were queried, but were absent in the
       *   query result, meaning that they are non-existent.
       * E.g.: `{ ftCacheKey1: true, ftCacheKey2: true, ftCacheKey3: 0, ... }`.
       * Here keys 1&2 are being-queried, and will be removed upon query success;
       * while key 3 was queried before, turned out as non-existent, and remains.
       */
      this.cacheFTQueried = {};

      /**
       * List of info-objects about still-ongoing fixedTerm-queries. Only when
       * all query results they depend on arrived, can they call their callback
       * `cb`, to report if all went OK.
       * E.g.: `[ { awaitedKeys: [ ftCacheKey1, .. ], cb: .. }, ... ]`.
       */
      this.cacheFTQueue = [];
    }



    /**
     * This adds a new, public function to this cache-enabled subclass.
     * Clears all caches and related data.
     * Does not clear queues of `cb`-functions that should still be called back.
     */
    clearCache() {
      this.cacheMO = {};
      this.cacheMOEmpties = {};

      this.cacheRT = false;

      this.cacheDI = {};
      this.cacheDIQueried = {};
      this.cacheDIGotAll = 0;

      this.cacheFTQueried = {};
    }



    // --- CACHING OF: MATCH-OBJECTS (with `getMatchesForString()`) ---

    /**
     * This overrides a parent-class function.
     * It adds a check for 'cache-empties' prediction (i.e. it checks if a
     * shorter string, for same `options`, already returned no matches):
     * - if so, it returns an empty list without launching a real query;
     * - if not, it lets the call pass through to let the parent launch a query.
     */
    getEntryMatchesForString(str, options, cb) {
      var key  = this._createCacheMOEmptiesKey(options);

      if (this._getCacheMOEmptiesPrediction(key, str)) {
        return callAsync(cb, null, { items: [] });   // Async: as spec requires.
      }

      super.getEntryMatchesForString(str, options, (err, res) => {
        this._updateCacheMOEmpties(key, str, err, res);
        return callAsync(cb, err, res);
      });
    }


    /**
     * This overrides a parent-class function.
     * - If the result of this function call is already in the cache, use that.
     * - Else, if an identical call already launched a query and is still
     *   waiting for the result, then queue `cb` for when the result comes in.
     * - Else, launch a real query, and when the result comes in,
     *   put the result in the cache and answer all queued callbacks.
     */
    getMatchesForString(str, options, cb) {
      var key  = this._createCacheMOKey(str, options);
      var item = this._getCacheMOItem(key);
      if (item)  return callAsync(cb, null, item);

      var queue = this.cacheMOQueue[key] = this.cacheMOQueue[key] || []; // It..
      queue.push(cb);                       // ..also inits the queue if needed.
      if (queue.length > 1)  return;  // Is this a concurrent request? Done!

      super.getMatchesForString(str, options, (err, res) => {
        if (!err)  this._setCacheMOItem(key, res);
        queue.forEach(cbf => callAsync(cbf, err, res));    // Call all on next..
        delete this.cacheMOQueue[key];  // ..event loops, after we're done here.
      });
    }


    /**
     * Makes a cache-key based on the arguments given to `getMatchesForString()`.
     */
    _createCacheMOKey(str, options) {
      return str + JSON.stringify(options || {});
    }


    _getCacheMOItem(key) {
      var item = this.cacheMO[key];
      if (!item)  return null;

      item.lastAccessed = getNowTime();  // Update item's last access time.
      return item.value;
    }


    _setCacheMOItem(key, value) {
      this.cacheMO[key] = { value, lastAccessed: getNowTime() };

      // If the cache grew too large, evict the oldest item.
      if (this.cacheMaxItems &&
          Object.keys(this.cacheMO).length > this.cacheMaxItems) {
        deleteOldestCacheItem(this.cacheMO);
      }
    }


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
     * Note: `cacheMOEmpties` is described in a comment in the constructor.
     */
    _updateCacheMOEmpties(key, str, err, res) {
      if (this.cacheMOPredictEmpties &&
          !err && res && res.items && !res.items.length &&
          str !== '') {  // Do not add for the empty string.

        var list = this.cacheMOEmpties[key] = this.cacheMOEmpties[key] || [];

        if (list.indexOf(str) == -1)  list.push(str);  // Add; avoid duplicates.
      }
    }


    /**
     * Given a search-string and options-object (stringified into `key`),
     * predicts if that query will return an empty list of match-objects
     * (so that the caller can avoid launching that query).
     * Returns `true` if it will be empty too, `false` if possibly not.
     */
    _getCacheMOEmptiesPrediction(key, str) {
      if (!this.cacheMOPredictEmpties)  return false;

      var list = this.cacheMOEmpties[key];

      // If `str` starts with any of the strings in this list, return `true`.
      return list  &&  list.findIndex(s => str.startsWith(s)) >= 0;
    }



    // --- CACHING OF: REFTERMS ---

    /**
     * This overrides a parent-class function.
     * It works with `cacheRT`: a list of all the dictionary's refTerms.
     * - Calls that happen while `cacheRT` is not yet filled, get queued.
     * - At the very first call, it also launches a query to fill the `cacheRT`;
     *   and when the result comes in, it resolves all queued calls.
     * - Calls that happen when `cacheRT` is filled, get answered immediately.
     */
    getRefTerms(options, cb) {
      if (typeof this.cacheRT !== 'boolean') {  // ==Is cache filled already?
        return this._getRefTermsFromSortedArray(this.cacheRT, options, cb);
      }

      this.cacheRTQueue.push({ options, cb });

      if (this.cacheRT === true)  return;  // ==Is cache-filling query launched?
      this.cacheRT = true;                 // Else, we launch the query now.

      super.getRefTerms({ perPage: Number.MAX_VALUE }, (err, res) => {
        this.cacheRT = err ? false : res.items;  // If fail, try again next time.

        this.cacheRTQueue.forEach(o => {
          if (err)  return callAsync(o.cb, err);
          // Note: `cacheRT` is already sorted, according to VsmDict's spec.
          this._getRefTermsFromSortedArray(this.cacheRT, o.options, o.cb);
        });
        this.cacheRTQueue = [];
      });
    }



    // --- CACHING OF: DICTINFOS ---

    /**
     * This overrides a parent-class function.
     * It delegates the three types of request to one of 3 other functions,
     * based on `options`. These types are:
     * - Request for all dictInfos.          --> [We call this a 'req-for-all'].
     * - Request based on a filter other than for dictIDs (bypasses the cache).
     * - Request based on a list of dictIDs. --> [We call this a 'req-for-IDs'].
     */
    getDictInfos(options, cb) {
      if (!options.filter)  return this._handleGetDictInfosAll(options, cb);

      // Requests that use a filter other than for dictIDs, bypass the cache;
      // but any valid result they receive will still update the cache.
      if (!options.filter.id ) {
        return super.getDictInfos(options, (err, res) => {
          if (!err)  res.items.forEach(di => this.cacheDI[di.id] = di);
          cb(err, res);
        });
      }

      this._handleGetDictInfosByIDs(options, cb);
    }


    /**
     * Handles a request-for-dictIDs.
     *
     * It works with a 'queue-object', consisting of:
     *  - `items`: this is an under-construction `items` result array, i.e. the
     *      dictInfos that this request will return, once we got them all.
     *      We start by marking them as not-queried, and gradually fill them in,
     *      as described in `_updateDIQueueObject()`. We fill them in:
     *      1) from dictInfos already in the cache,
     *      2) from dictInfos already requested in an earlier query, whose
     *         answer we currently await (so we may get them soon), and
     *      3) from the (remaining) dictInfos that we'll launch a query for now.
     *  - `options` }
     *  - `cb    `  }  : the arguments to this getDictInfos()-call.
     *
     * Overview of implementation:
     * - If all dictInfos are available already, we can callback immediately.
     * - Else, some may be unavailable but already queried, and some may need
     *   to be queried now. In any case, we put our queue-object on the queue.
     * - Then we query only the to-query ones; unless we expect a req.-for.all's
     *   result to come in, which we would be able to use.  And then we wait.
     * - Then whenever a new query result comes in, for any `getDictInfo()` call,
     *   we continue building each queue-object's `items`, and if any of these
     *   got all dictInfos they need, we can call their `cb`.
     *   Others keep waiting again.
     */
    _handleGetDictInfosByIDs(options, cb) {
      // Create a queue-object (based on unduplicated request-dictIDs), mark all
      // request-dictIDs as not yet gotten, try to fill in as many as possible,
      // and callback if we got them all already.
      var items = [...new Set(options.filter.id)] .map(id => ({id, _q: false}));
      var qObj = { items,  options,  cb };
      if (this._updateDIQObjAndCallbackMaybe(qObj) == 0)  return;

      // We depend on query result/s now. So add our queue-object to the queue.
      this.cacheDIQueue.push(qObj);

      // If a query-for-all-dictIDs was already launched, just wait for that.
      if (this.cacheDIGotAll == 0.5)  return;

      // Find the IDs that still need to be queried. If none are left to query,
      // we only depend on ongoing queries, so we only have to wait now.
      var queryIDs = qObj.items.filter(di => di._q === false) .map(di => di.id);
      if (!queryIDs.length)  return;

      // Mark our queryIDs as pending, and launch an unpaginated query for them.
      queryIDs.forEach(id => this.cacheDIQueried[id] = true);
      return super.getDictInfos(
        { filter: { id: queryIDs }, perPage: Number.MAX_VALUE },
        (err, res) => this._handleDIQueryResult(err, res, queryIDs) );
    }


    /**
     * Handles a request for all dictInfos (i.e. made with no `options.filter`).
     *
     * Implementation:
     * - If a request-for-all's results were ever received, then just
     *   return the entire cache now.
     * - If not, then first queue a queue-object with "items: true" as a
     *   special "request-for-all" signal, and:
     *   - if a parallel request-for-all is already running, just return & wait;
     *   - else query for all now.
     */
    _handleGetDictInfosAll(options, cb) {
      var qObj = { items: true, options, cb };
      if (this._updateDIQObjAndCallbackMaybe(qObj) == 0)  return;

      this.cacheDIQueue.push(qObj);
      if (this.cacheDIGotAll == 0.5)  return;

      // Signal that a query-for-all result is now awaited, and launch an
      // unpaginated query for all.
      this.cacheDIGotAll = 0.5;
      return super.getDictInfos(
        { perPage: Number.MAX_VALUE },
        (err, res) => this._handleDIQueryResult(err, res, true) );
    }


    /**
     * Handles the result/error of an actual getDictInfos() query:
     * - on error, forwards the error to all dependent, queued callbacks; else:
     * - adds the received query result to the cache, and calls back any queued
     *   callbacks that now have all the dictInfos they needed to receive.
     *
     * Implementation:
     * + First, update `cacheDI/-Queried/-GotAll` for all cases:
     *   - Upon a req-for-all result, always update `cacheDIGotAll`.
     *     - If also not error, unmark all pending queryIDs (as we got them all
     *       now); and start using the entire result as the new cache;
     *   - Upon a req-for-IDs result, always unmark our queryIDs as pending.
     *     - If also not error, put all results in the cache; and
     *       any queried ID that wasn't received in the result is apparently
     *       non-existent in the datastore, so mark it as such in `cacheDI` (so
     *       that any other requests that may be relying on *this* query to get
     *       that ID for them, will be informed about this too).
     * + Second, process `cacheDIQueue` based on the above calculated new state.
     *   - If it's an error:
     *     - If req-for-all, then send the error to all queue-objects, from
     *       the first req-for-all onwards, because all those (and only those)
     *       depend on this query's results.
     *     - If req-for-IDs, then we have to send the error all queue-objects
     *       that depend on any of this query's queryIDs, except any after (/at)
     *       the first req-for-all, because those get it from that req-for-all.
     *   - If it's not an error:
     *     - If req-for-all, then we'll be able to answer _all_ requests now (so
     *       we may also answer any queued req-for-IDs early now).
     *     - If req-for-IDs, then we can answer all queued requests that got all
     *       the dictIDs they need now.
     *   + ('Step 2' below, is compactified version of this part).
     */
    _handleDIQueryResult(err, res, queryIDs) {
      // Step 1: update `cacheDI/-Queried/-GotAll`.
      if (queryIDs === true) {  // == It's a request for all dictInfos.
        this.cacheDIGotAll = err ? 0 : 1;
        if (!err) {
          this.cacheDIQueried = {};
          this.cacheDI = {};
          res.items.forEach(di => this.cacheDI[di.id] = di);
        }
      }
      else {                    // It's a request that filters for some dictIDs.
        queryIDs.forEach(id => delete this.cacheDIQueried[id]);
        if (!err) {
          res.items.forEach(di => this.cacheDI[di.id] = di);
          queryIDs.forEach(id => this.cacheDI[id] = this.cacheDI[id] || '-');
        }
      }

      // Step 2: process `cacheDIQueue`, based on the new cache-state.
      var rRFA;  // Tells if the iterator Reached a Request For All yet.
      this.cacheDIQueue = this.cacheDIQueue
        .map(o => {
          rRFA = rRFA || o.items === true;
          /* On error:
               continue if: result-for-all, and `o` is before any req-for-all;
               or if: result-for-IDs, and `o` doesn't depend on `queryIDs` or is
                      at/after a req-for-all (that it then depends on instead).
             On success, continue if queue-obj `o` couldn't be completed yet. */
          return err ? (
            ( queryIDs === true  &&  !rRFA  ||
              queryIDs !== true  &&  (
                rRFA || !o.items.some(di => queryIDs.includes(di.id)) )
            ) ? o : callAsync(o.cb, err) && 0
          ) : this._updateDIQObjAndCallbackMaybe(o);
        })
        .filter(o => o);  // Remove called-back ones.
    }


    /**
     * - Updates a req-for-ID's queue-object's `items` array (replaces it).
     *   Each item is, based on its `id`, updated or left to be either:
     *   - `{ id:.., name: .. }`, a real dictInfo found in cache, earlier or now;
     *   - `{ id:.., _q: true }`, if some other call already queried for that
     *                            dictID but the result did not come in yet;
     *   - `{ id:.., _q: false}`, if that dictID still needs to be queried.
     * - Removes dictIDs that the cache now marks as non-existent (as '-').
     * - Returns the new `items` array.
     */
    _updateDIQueueObject(qObj) {
      return qObj.items = qObj.items
        .map(di =>
          di._q === undefined  &&  di  ||            // Already got it? Keep it.
          this.cacheDI[di.id]  ||                          // In cache? Take it.
          { id: di.id, _q: !!this.cacheDIQueried[di.id] })  // Status-update it.
        .filter(di => di != '-');                   // Remove non-existent ones.
    }


    /**
     * Updates a queue-object's `items` with any new cache info,
     * and if this filled it completely, calls `cb` with it.
     * Returns the queue-object if `cb` was not called yet (as a signal that
     * this queue-object needs to stay on the queue), and `0` if `cb` was called.
     *
     * Implementation:
     * - For a request-for-all (signalled by `items === true`):
     *   - if any req-for-all finished already, then fill `items` with all
     *     dictInfos in cache (minus ones tagged as non-existent); and callback.
     *   - else abort.
     * - For a request-for-dictInfos, first update the `qObj.items` with any new
     *   data that may now be in the cache.
     *   - If any req.-for-all finished already too, this should be enough data:
     *     callback. But first remove any absent dictIDs as they're non-existent.
     *   - Else: - if any more dictID/Infos are awaited, abort;
     *           - else callback.
     *  Before callback, the `items` array is edited according to `qObj.options`.
     */
    _updateDIQObjAndCallbackMaybe(qObj) {
      var items = qObj.items;

      if (items === true) {
        if (this.cacheDIGotAll == 1) {
          items = Object.values(this.cacheDI) .filter(di => di != '-');
        }
        else  return qObj;
      }
      else {
        items = this._updateDIQueueObject(qObj);
        if (this.cacheDIGotAll == 1) {
          items = items.filter(e => e._q === undefined);
        }
        else  if (items.some(e => e._q !== undefined))  return qObj;
      }

      var sortKey = qObj.options.sort || 'id';
      var page    = qObj.options.page || 1;
      var perPage = qObj.options.perPage || Number.MAX_VALUE;
      var skip = (page - 1) * perPage;
      items = items
        .sort((a, b) => {
          a = a[sortKey].toLowerCase();
          b = b[sortKey].toLowerCase();
          return a < b ?  -1 :  a > b ?  1 :  0;
        })
        .slice(skip, skip + perPage);
      callAsync(qObj.cb, null, { items });
      return 0;
    }



    // --- CACHING(-enhancement) OF: FIXEDTERMS ---

    /**
     * This overrides a parent-class function.
     * - It analyzes the `idts` argument, and lets only never-queried-before
     *   id+term couples pass through, for real querying and subsequent addition
     *   to VsmDictionary root-class's cache (`this.fixedTermsCache`).
     * - It simply calls back to tell if that query went OK or not.
     * - If its query, or any concurrent queries that it relied on to get part
     *   of its id+terms, failed, it reports the error.
     *
     * + It uses the parent's `fixedTermsCache` to know which idts were gotten.
     * + It uses a `cacheFTQueried` to know which are queried but still awaited.
     * + It uses a `cacheFTQueue` for managing to call back `cb` only after
     *   all dependent-upon fixedTerms have arrived.
     */
    loadFixedTerms(idts, options, cb) {
      // Augment the given fixedTerm-object `idts`, to a list that holds
      // objects like `[ { key: ftCacheKey, idt: {id:..,str:..}, }, ... ]`.
      var aidts = idts  // `aidts` = Augmented IDTS.
        .map(idt => ({ key: this._idtToFTCacheKey(idt.id, idt.str), idt }));

      // Get those that are either queried-but-still-awaited, or to-query-now;
      // i.e. drop those that are in the cache or are known to be non-existent.
      var aidtsAwait = aidts.filter(o =>
        !this.fixedTermsCache[o.key]  &&  this.cacheFTQueried[o.key] !== 0);
      if (!aidtsAwait.length)  return callAsync(cb, null);  // None? All done.

      // Get those we have to query now (:take out the not-`true`-tagged-ones).
      var aidtsQuery = aidtsAwait.filter(o => !this.cacheFTQueried[o.key]);

      // Queue a callback+info object, to be resolved after all awaiteds arrive.
      this.cacheFTQueue.push({ awaitedKeys: aidtsAwait.map(o => o.key), cb });

      // If no new ones to query, just wait for queries we depend on to finish.
      if (!aidtsQuery.length)  return;

      // Mark those to be queried now, as being-queried, and launch the query.
      aidtsQuery.forEach(o => this.cacheFTQueried[o.key] = true);

      super.loadFixedTerms(
        aidtsQuery.map(o => o.idt),
        options,
        err => this._handleFTQueryResult(err, aidtsQuery.map(o => o.key))
      );
    }


    /**
     * Handles the result/error of a loadFixedTerms() query to the parent class.
     * + If a query failed, then all requests that were waiting+depending on it
     *   to load some of their requested fixedTerms, are sent the same error.
     */
    _handleFTQueryResult(err, queriedKeys) {
      // In `cacheFTQueried`, unregister all queried fixedTerms that got loaded.
      // And any that were queried but not loaded are apparently nonexistent; so
      // we zero-tag them to avoid querying them a next time.
      // + On error, just unregister all queried fixedTerms.
      queriedKeys.forEach(key => {
        if (err || this.fixedTermsCache[key])  delete this.cacheFTQueried[key];
        else  this.cacheFTQueried[key] = 0;
      });

      // In all queued cb+info objects, remove the just queried fixedTerm-keys.
      // If that makes anyone's `awaitedKeys` empty, it's done waiting, so cb it.
      // + On error, `cb(err)` all those who awaited any of the queried keys.
      this.cacheFTQueue = this.cacheFTQueue
        .map(o => {
          var n = o.awaitedKeys.length;
          o.awaitedKeys = o.awaitedKeys.filter(k => !queriedKeys.includes(k));
          return (err && o.awaitedKeys.length == n ||
            !err      && o.awaitedKeys.length) ? o : callAsync(o.cb, err) && 0;
        })
        .filter(o => o);  // Remove called-back ones.
    }

  };
};
