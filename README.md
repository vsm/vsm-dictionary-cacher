# vsm-dictionary-cacher

<br>

## Summary

`vsm-dictionary-cacher` is a wrapper around VSM-dictionaries,  
to speed up requests for string-matches in three ways:

- It stores results from requests to `getMatchesForString()` in a cache.  
  These results are returned for subsequent requests
  that use same search-string &amp; options, instead of re-running the query.

  > This helps e.g. `vsm-autocomplete` avoid making duplicate requests to an
    online dictionary server.  
    It creates a more responsive autocomplete when the user
    types, and then backspaces.

- It also prevents launching a second query to a server, that has the same
  search-string &amp; options as an ongoing query.  
  Instead, it makes the second query wait, and when the first one's result
  comes in, it shares that result immediately with the second one.

  > This helps e.g. `vsm-autocomplete` avoid making duplicate requests  
    when a user types, and backspaces or re-types quickly.

- And it can remember for which strings there were no matches.  
  Then for subsequently queried strings, that start with such a 'no matches'
  string, it can immediately return 'no matches' too.

  > This helps e.g. `vsm-autocomplete` avoid making unnecessary requests  
    for search-strings for which a substring already returned no matches.

<br>

This package provides a factory function that accepts any VsmDictionary class,
and returns a subclass of it,  
which simply adds an extra layer of caching functionality
to `getMatchesForString()`.

<br>

## Use

Install like (after also installing a `vsm-dictionary-...` of choice) :
```
npm install vsm-dictionary-cacher --save-prod
```

Then use like:
```
const Dictionary       = require('vsm-dictionary-local');  // ...or any other VsmDictionary implementation.
const cacher           = require('vsm-dictionary-cacher');
const CachedDictionary = cacher(Dictionary);  // This makes a new subclass.


var dict = new CachedDictionary();  // This makes an instance.


// This will query the Dictionary as normal, bypassing the cache.
dict.getMatchesForString('abc', {filter: {dictID: ['Foo']}}, (err, res) => {

  // This will get the result from the cache (instead of re-running the query).
  dict.getMatchesForString('abc', {filter: {dictID: ['Foo']}}, (err, res) => {

  });

  // These will *not* get their result from the cache.
  dict.getMatchesForString('abc', {filter: {dictID: ['BAR']}}, (err, res) => {});
  dict.getMatchesForString('QQQ', {filter: {dictID: ['Foo']}}, (err, res) => {});

});
```

<br>

## Options

You can give an options object as second argument to the factory function,
with these optional properties:

- `maxItems`: {Number}:  
    This limits the amount of items (1 _item_ = 1 query result) kept in the
    cache. The least recently added or accessed item will be evicted first.  
    Default is 0, which means unlimited storage.
- `maxAge`: {Number}:  
    This sets the maximum amount of time (in milliseconds) that an item may
    live in the cache, after being added or last accessed.
    Expired items will be evicted.  
    Default is 0, which means no expiration.  
- `predictEmpties`: {Boolean}:  
    If `true`, then it keeps a list of strings (per options-object) for which
    `getMatchesForString()` returned no results (i.e.: `{ items: [] }`).  
    Then for any subsequent query (with same options) for a string that
    starts with any such empty-returning-string, we can assume that no results
    will be returned either.
    E.g. if a search for 'ab' returned nothing, then neither will 'abc'.  
    So we can avoid running that query and immediately return the empty
    `{ items: [] }` for 'abc'.
    Default is `true`.  
    - Note: For that collection of strings, `maxItems` and `maxAge` do not apply.  
      But the collection gets cleared whenever the main cache gets cleared (so
      also after a long time of no access (see below under 'Memory management')).
    - Note: a query for matching refTerms (to `getRefTerms()`)
      will still be made,  
      because e.g. after a call for "i" would give no results (and "i" ends up
      in cacheEmpties), a subsequent call for the refTerm "it" should still
      return it as a result.
      (Note that a refTerm is only returned as an exact string match).
    - Note: a call to `getMatchesForString()` is also still made,  
      because e.g. after a call for "1e" gave no results,
      a subsequent call for the valid number-string "1e5"
      should still return it as a result.

Specify options like:
```
const CachedDictionary = cacher(Dictionary, { maxItems: 100, maxAge: 180000 });
```


<br>

## Functions

The wrapper adds an extra function to the VsmDictionary subclass:

- `clearCache()`:  
    This empties the cache. It also empties the list used by `predictEmpties`.


<br>

## Additional specification

<br>

### Memory management

When `maxAge` is not 0 (i.e. when cache items can expire), then:
- cache items that are attempted to be retrieved, but turn out to be
  expired, are deleted only at that point;
- so cache items that are not accessed, are not deleted right after
  they expire;
- but the whole cache gets cleared automatically, when `maxAge` ms has passed
  since any last cache-access; i.e. all items' memory gets released then.  
  (So, cache-memory gets released only after *all* items have passed maxAge,
  instead of managing expiration+deletion for each item individually).

<br>

### Concurrent requests for the same string+options

It can happen that `getMatchesForString()` gets called a second time with the
same arguments, but that results from the first call haven't arrived yet
(i.e. the first query hasn't called its callback with a result yet).

- In that case, the subclass will wait for the first callback to be called,
  and then almost immediately (on the next event-loop) call the second request's
  callback with the same error+result, instead of launching the query again.

<br>

### Errors

When a query on the original storage fails, then no item will be added
to the cache, and no attempt to re-query will be made by `vsm-dictionary-cacher`.  
This means that for concurrent requests (as described above),
the same error will be returned almost-immediately by all those requests.
