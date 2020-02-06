# vsm-dictionary-cacher

<br>

## Summary

`vsm-dictionary-cacher` augments a given VSM-dictionary with a layer of
caching functionality.

This speeds up requests for string-matches, refTerms, and dictInfos;
and fixedTerms-preloading.

<br>

## Use in Node.js

Install like (after also installing a `vsm-dictionary-...` of choice) :
```
npm install vsm-dictionary-cacher
```

Then use like:
```js
const Dictionary       = require('vsm-dictionary-local');  // ...or any other VsmDictionary implementation.
const cacher           = require('vsm-dictionary-cacher');
const CachedDictionary = cacher(Dictionary);  // This makes a cache-enabled subclass.


var dict = new CachedDictionary();  // This makes an instance.


// This will query the Dictionary as normal, bypassing the cache.
dict.getMatchesForString('abc', {filter: {dictID: ['Foo']}}, (err, res) => {
  console.dir(res);

  // This will get the result from the cache, instead of re-running the query.
  dict.getMatchesForString('abc', {filter: {dictID: ['Foo']}}, (err, res) => {
    console.dir(res);
  });

  // These will *not* get their result from the cache.
  dict.getMatchesForString('abc', {filter: {dictID: ['BAR']}}, (err, res) => {});
  dict.getMatchesForString('QQQ', {filter: {dictID: ['Foo']}}, (err, res) => {});


  // And similar behavior for the other three cached functions:
  // - dict.getRefTerms({}, cb)
  // - dict.getDictInfos({}, cb)
  // - dict.loadFixedTerms([], {}, cb)

});
```

Specify options like:
```js
const CachedDictionary = cacher(Dictionary, { maxItems: 1000 });
```

<br>

## Use in the browser

```
<script src="https://unpkg.com/vsm-dictionary-cacher@^1.0.0/dist/vsm-dictionary-cacher.min.js"></script>
```
after which it is accessible as the global variable `VsmDictionaryCacher`.  
Then it can be wrapped around a VsmDictionary, e.g. a `VsmDictionaryLocal`, like:

```
....

<script src="https://unpkg.com/vsm-dictionary-local@^2.0.0/dist/vsm-dictionary-local.min.js"></script>

<script>
var dict = new (VsmDictionaryCacher(VsmDictionaryLocal)) (options);
dict.getMatchesForString(....
</script>
```

<br>

## Details

This package provides a factory function that accepts any VsmDictionary
(sub)class, and returns a (further) subclass of it,  
which inserts cache handling code into several functions:

<br>

+ It speeds up requests for string-matches, to `getMatchesForString()`, in
  three ways:

  - It stores results from requests to this function in a cache.  
    These results are returned for subsequent requests
    that use same search-string &amp; options, instead of re-running the query.

    > This helps e.g. `vsm-autocomplete` avoid making duplicate requests to an
    > online dictionary server.  
    > It creates a more responsive autocomplete when the user
    > types, and then backspaces.

  - It also prevents sending a second (or more) query to the underlying
    datastore, if this query has the same search-string &amp; options as an
    ongoing query, whose results haven't arrived yet.  
    Instead, it puts such identical queries in a queue, and when the first one's
    result comes in, it shares its error+result with the queued ones,
    almost immediately (=on individual, next event-loops).

    > This helps e.g. `vsm-autocomplete` avoid making duplicate requests  
    > when a user types and backspaces quickly, before any results could come in.

    Note: when a query on the underlying storage fails, then no item will be
    added to the cache, and no attempt to re-query will be made by the queued
    ones.  
    This also means that on error, the same error would be returned by all
    queued requests.

  - It can also remember for which strings there were no 'normal entry'-type
    matches.  
    Then for subsequently queried strings, that start with such a 'no matches'
    string, it can immediately return an empty list for the 'entry-matches' too.
    (But it still checks for refTerm/number/etc-type matches).

    > This helps e.g. `vsm-autocomplete` avoid making unnecessary requests for
    > search-strings, for which a substring already returned no entry-matches.

<br>

+ It maintains a cache for `getRefTerms()`.

  - There are usually only a small number of refTerms, and they are just Strings.  
    Therefore, at a first call for anything, it queries all of them, and puts
    them into a cache that is used for all further lookups.

    > This makes e.g. `vsm-autocomplete` not launch two queries per
    > search-string (i.e. one for entries, and one for refTerms).  
    > And for cacheEmpty-hits, it will even serve all data from either cache or
    > computation.

  - It also catches and prevents any concurrent calls, until this cache data
    is received.

<br>

+ It partially maintains a cache for `getDictInfos()`.

  - It caches all dictInfo-objects that are returned from any queries to the
    underlying datastore, no matter what `options` were used.

  - Then it may use this cache:
    - It uses it: _only_ for requests that filter for a list of dictIDs
      (i.e. having a `options.filter.id`),  
      _or_ for requests that ask all dictInfos (i.e. having no `options.filter`).
    - &bull; Then it collects all dictInfos with a cache-hit in the
      dictInfos-cache,  
      &bull; and sends a query _only_ for the dictInfos that had a cache-miss,
      _and_ that are not marked as being-queried by another concurrent
      `getDictInfos()` call,  
      &bull; after marking these as being-queried now too.  
      &plus; Note: queries to the underlying datastore are made, explicitly
      unpaginated (i.e. with `options = { perPage: Number.MAX_VALUE, ... }`).
    - When all dictInfos that it depends on have come in, (possibly as partial
      results from several other concurrent calls), then it finally returns
      its own, complete, assembled result.
    - The implementation of this is not trivial. But it ensures that for a
      large amount of concurrent requests (which may be launched when an app
      starts up), no dictID is queried twice.  
      And it works even if `clearCache()` (see below) is called during this
      process.

      > A `vsm-autocomplete` needs a corresponding dictInfo for each of its
      > string-matches.  
      > So if its string-matches already came from cache-hits, then the above
      > makes all its other data also come only from cache.
  
      > If a `vsm-box` with a template, or several `vsm-box`es loaded on a same
      > page, would launch multiple concurrent requests for dictInfos, then this
      > caching may result in a lot less queries to the underlying datastore.

<br>

+ It enhances the cache management of `loadFixedTerms()`.

  - - Note: this function (of the VsmDictionary parent class) queries
      a VsmDictionary subclass's `getEntries()`, and puts the processed
      results in its own simple cache (in the VsmDictionary parent class).
    - But if a web page would contain multiple `vsm-box`es based on a template,
      then each of them may call the (shared) VsmDictionary's `loadFixedTerms()`
      and launch a query. This would query and add results to the VsmDictionary's
      `fixedTermsCache`, no matter whether these results were in there already.

  - &bull; It maintains a list of fixedTerms (`idts`) that have ever been
    queried.  
    &bull; It removes, from a request's `idts`-argument, any that were queried
    before,  
    &bull; and then launches the query only for the remaining `idts`,  
    &bull; after marking them as 'pending/having-been-queried-now',  
    &bull; so that concurrent calls can be prevented from requesting anything
    twice.

    Note: the `options.z`, for z-object-pruning, is not taken into account here,
    because VsmDictionary's fixedTerms-cache does so neither.

    > This prevents that `loadFixedTerms()` is called multiple times for the same
    > data, when loading multiple `vsm-box`es with the same template.

<br>

## Options

An options object can be given as second argument to the factory function
(see example above), with these optional properties:

- `maxItems`: {Number}:  
    This limits the amount of items kept in the string-match cache (only).
    One item equals the result of one `getMatchesForString()` query (which is
    often a list of match-objects).  
    When adding a new item to a full cache, the least recently added or accessed
    item gets removed first.  
    Default is 0, which means unlimited storage.
    + Note: this pertains to _string-match-objects_ only;  
      so not to refTerms (they are small and few), not to dictInfos (same reason,
      and the result of one query is spread out over multiple cache-items, which
      is hard to manage), and not to fixedTerms (same).
- `predictEmpties`: {Boolean}:  
    If `true`, then it keeps a list of strings (per options-object) for which
    `getEntryMatchesForString()` returned no results (i.e.: `{ items: [] }`).  
    Then for any subsequent query (with same options) for a string that
    starts with any such empty-returning-string, we can assume that no results
    will be returned either.  
    E.g. if a search for 'ab' returned no matching entries, then neither will
    'abc'. So it can avoid running that query and immediately return the
    empty `{ items: [] }` for 'abc'.  
    Default is `true`.  
    - Note: `maxItems` does not apply to this collection of strings either.  
      But the collection gets cleared, like everything else, by a call
      to `clearCache()` (see below).
    - Note: this is handled in `getEntryMatchesForString()`, not in
      `getMatchesForString()`, because the latter may still add 'extra' matches
      (refTerm/number/fixedTerm), other than the 'entry'-type matches.  
      - Example 1: after a call for "i" would give no entry-matches (and "i"
        ends up in the 'cacheEmpties'), a subsequent call for "it" should still
        return "it" as a refTerm-match.  
        (Note that a refTerm only matches for a full, not partial, string match).  
      - Example 2: after a call for "1e" gave no results, a subsequent call
        for the valid number-string "1e5" should still return it as a result.

<br>

## Functions

An extra function is added to the VsmDictionary subclass:

- `clearCache()`:  
    This removes all data from the cache layer, including e.g. the list used by
    `predictEmpties`.

<br>

## License

This project is licensed under the AGPL license - see [LICENSE.md](LICENSE.md).
