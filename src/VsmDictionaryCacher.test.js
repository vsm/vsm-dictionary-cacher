const cacher = require('./VsmDictionaryCacher');
const sinon = require('sinon');
const chai = require('chai');  chai.should();
const expect = chai.expect;


describe('VsmDictionaryCacher.js', function() {
  var Dictionary;
  var CachedDictionary;
  var dict;

  var called;  // This will be set to 1 if the stub getMatchesFor..() is called.
  var result;  // The stub function will return this, whatever it is set to.
               // (See below).

  var clock;  // See https://stackoverflow.com/questions/17446064


  function makeVsmDictionaryStub(cacheOptions, delay = 0, error = null) {
    Dictionary = class VsmDictionaryStub {

      // This stub function would normally *query* an underlying datastore.
      // So if it is called, it means that the function which overrides it
      // (in the cache-handling subclass) did not use the cache.
      // - In some tests, we can know if *this function here* was called, by
      //   checking if `called` was changed to 1.
      // - In other tests, we put a particular value in `result`,
      //   which *this function here*, if called, will return.
      //   Then after we call getMatchesForString() (i.e. the subclass's one),
      //   we can e.g. check if the cache (expired and) got updated
      //   with this new `result`.
      getMatchesForString(str, options, cb) {
        setTimeout(
          function f() { called = 1;  cb(error, result); },
          delay || 0
        );
      }

    };
    CachedDictionary = cacher(Dictionary, cacheOptions);
    dict = new CachedDictionary();
  }


  const _R1 = { items: ['test1'] };
  const _R2 = { items: ['test2'] };
  const _R3 = { items: ['test3'] };
  const _R4 = { items: ['test4'] };
  const _R0 = { items: [] };  // == the 'empty result', i.e.: no match-objects.

  const _a = 'a{}';  // Cache-key for search-string 'a' and options-object `{}`.


  beforeEach(function() {
    // Note: `called` gets set to 0 before each test. But it can get set to 1
    //       in a `getMatchesForString()` call. So if a test uses multiple such
    //       calls, it must reset `called` to 0 between those calls (if needed).
    called = 0;
    result = { items: ['default'] };
  });


  describe('basic caching  [these tests run on the same `dict`]', function() {

    // All tests in this block work on this same dictionary, of which the
    // cache is not cleared but may grow after each operation !
    before(function() {
      makeVsmDictionaryStub();
    });

    it('lets the first call to getMatchesForString() pass through ' +
      'to the parent class', function(cb) {
      result = _R1;
      dict.getMatchesForString('a', {}, (err, res) => {
        called.should.equal(1);
        expect(err).to.equal(null);
        res.should.deep.equal(_R1);
        cb();
      });
    });

    it('...but uses cached results for a second call ' +
      'with same arguments', function(cb) {
      dict.getMatchesForString('a', {}, (err, res) => {
        called.should.equal(0);
        res.should.deep.equal(_R1);
        cb();
      });
    });

    it('does not use cached results for a different search-string', function(cb) {
      result = _R2;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called.should.equal(1);
        res.should.deep.equal(_R2);
        cb();
      });
    });

    it('...but does so on the second call', function(cb) {
      dict.getMatchesForString('ab', {}, (err, res) => {
        called.should.equal(0);
        res.should.deep.equal(_R2);
        cb();
      });
    });

    it('does not use cached results for a different options object', function(cb) {
      result = _R3;
      dict.getMatchesForString('a', { x: 1 }, (err, res) => {
        called.should.equal(1);
        res.should.deep.equal(_R3);
        cb();
      });
    });

    it('...but does so on the second call', function(cb) {
      dict.getMatchesForString('a', { x: 1 }, (err, res) => {
        called.should.equal(0);
        res.should.deep.equal(_R3);
        cb();
      });
    });

    it('clears the cache', function(cb) {
      (Object.keys(dict.cacheMO).length > 1).should.equal(true);
      dict.clearCache();
      Object.keys(dict.cacheMO).length.should.equal(0);
      cb();
    });

    it('repeats the real query after clearing the cache', function(cb) {
      result = _R4;
      dict.clearCache();
      dict.getMatchesForString('a', {}, (err, res) => {
        called.should.equal(1);
        expect(err).to.equal(null);
        res.should.deep.equal(_R4);
        cb();
      });
    });

  });


  describe('maxItems', function() {

    beforeEach(function() {
      makeVsmDictionaryStub({ maxItems: 1 });
    });

    it('evicts the oldest item when the cache overflows', function(cb) {
      dict.getMatchesForString('a', {}, (err, res) => {
        expect(dict.cacheMO[_a]).to.not.equal(undefined);  // 'a' is in cache.

        setTimeout(() => {  // Make sure that 2nd add really has later timestamp.
          dict.getMatchesForString('b', {}, (err, res) => {
            Object.keys(dict.cacheMO).length .should.equal(1);
            expect(dict.cacheMO[_a]).to.equal(undefined);  // Now
                          // the oldest item, 'a', left the cache.
            cb();
          });
        }, 2);
      });
    });

  });


  describe('maxAge', function() {

    beforeEach(function() {  // Makes new VsmDictionary instance for each test!
      clock = sinon.useFakeTimers();
      makeVsmDictionaryStub({ maxAge: 2000 });
    });

    afterEach(function() {
      clock.restore();
    });


    it('returns an item from cache when it is not expired', function(cb) {
      result = _R1;  // This will be put in the cache by the first call.
      dict.getMatchesForString('a', {}, () => {});  // Puts 'a' in cache.
      clock.tick(1999);

      result = _R2;  // This would be returned if a non-cache call were made now.
      dict.getMatchesForString('a', {}, () => {}); // Gets it from cache.

      clock.tick(1);  // (Makes the above async callback get called).
      dict.cacheMO[_a].value.should.deep.equal(_R1);  // 'a' came from cache.
      cb();
    });


    it('does not return an expired item from cache, ' +
       'but re-queries and updates it', function(cb) {
      result = _R1;
      dict.getMatchesForString('a', {}, (err, res) => {
        res.should.deep.equal(_R1);
      });

      // We add an extra cache-access for something else than 'a', so that
      // the auto-clear-cache timer does not interfere in our test.
      // The following three lines actually correspond to a `clock.tick(2001)`:
      clock.tick(500);
      dict.getMatchesForString('b', {}, () => {});
      clock.tick(1501);

      result = _R2;
      dict.getMatchesForString('a', {}, (err, res) => {  // Re-queries 'a'.
        res.should.deep.equal(_R2);
      });

      clock.tick(1);  // (Makes the above async callback get called).
      dict.cacheMO[_a].value.should.deep.equal(_R2);  // 'a' came from query.
      cb();
    });


    it('empties the cache automatically after `maxAge` ms, ' +
       'after only cache-access', function(cb) {
      dict.getMatchesForString('a', {}, () => {});

      clock.tick(1999);
      expect(dict.cacheMO[_a]).to.not.equal(undefined); // 'a' is still there.

      clock.tick(2);  // No call to getMatchesForString() now.  Just pass time.
      expect(dict.cacheMO[_a]).to.equal(undefined);  // 'a' is gone now.
      cb();
    });


    it('empties the cache automatically after `maxAge` ms, ' +
       'after last cache-access', function(cb) {
      dict.getMatchesForString('a', {}, () => {});

      clock.tick(1500);
      dict.getMatchesForString('b', {}, () => {});  // Make a new cache access.

      clock.tick(1999);  // Now 1500+1999 ms passed since adding 'a'.
      expect(dict.cacheMO[_a]).to.not.equal(undefined); // 'a' is still there.

      clock.tick(2);  // Now 2001 ms passed since the last cache access.
      expect(dict.cacheMO[_a]).to.equal(undefined);  // 'a' is gone now.
      cb();
    });

  });


  describe('concurrent requests piggy-backing', function() {

    beforeEach(function() {
      clock = sinon.useFakeTimers();
    });

    afterEach(function() {
      clock.restore();
    });


    it(['if a call 1 takes some time, and meanwhile an identical call 2',
        'and a different call 3 are made, then call 2 is put on hold;',
        'and then when call 1 finishes:',
        'call 2 immediately finishes as well, and reuses call 1\'s result;',
        'but not so for call 3']
          .join('\n          '), function(cb) {
      makeVsmDictionaryStub({ maxAge: 2000 }, 100);  // 100 ms response delay.
      var res1 = 0;
      var res2 = 0;
      var res3 = 0;
      result = _R1;
      dict.getMatchesForString('a', {},       (err, res) => { res1 = res });

      clock.tick(99);  // This waits 99 ms before making calls 2 and 3.
      dict.getMatchesForString('a', {},       (err, res) => { res2 = res });
      dict.getMatchesForString('a', { x: 1 }, (err, res) => { res3 = res });

      clock.tick(0);  // (Makes the above async callback get called).
      res1.should.equal(0);  // Call 1 did not finish before the 100 ms delay.
      res2.should.equal(0);  // Neither did call 2.
      res3.should.equal(0);  // (Neither did call 3).

      clock.tick(3);  // This makes 102 ms pass since call 1 was made.
      res1.should.deep.equal(_R1);  // Now call 1 returned its result.
      res2.should.deep.equal(_R1);  // And call 2 returned its result _early_.
      res3.should.deep.equal(0);    // But call 3 did not yet.

      clock.tick(98);
      res3.should.deep.equal(_R1);  // 101 ms after its own launch, call 3 did.
      cb();
    });


    it(['if a call 1 takes some time, and meanwhile an identical call 2 is ',
        'made (which is then put on hold), and then call 1 errors:',
        'then call 2 immediately returns the same error too']
          .join('\n          '), function(cb) {
      makeVsmDictionaryStub({ maxAge: 2000 }, 100, 'ERR');  // => delay + error.
      var err1 = 0;
      var err2 = 0;
      dict.getMatchesForString('a', {}, (err, res) => { err1 = err });

      clock.tick(99);
      dict.getMatchesForString('a', {}, (err, res) => { err2 = err });
      err1.should.equal(0);  // Call 1 did not finish before 100 ms delay.
      err2.should.equal(0);  // Neither did call 2.

      clock.tick(3);  // This makes 102 ms pass since call 1 was made.
      err1.should.equal('ERR');  // Now call 1 finished.
      err2.should.equal('ERR');  // And call 2 finished early.
      cb();
    });

  });


  describe('predictEmpties', function() {
    it('for: default `true`: after no matches for "ab", ' +
       'it avoids a real query for "abc"', function(cb) {
      makeVsmDictionaryStub();  // Using the default: `{ predictEmpties: true }`.
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called = 0;    // Reset `called` between multiple `getMatches...` calls.
        result = _R1;  // Will not be used if empty-prediction kicks in first.
        dict.getMatchesForString('abc', {}, (err, res) => {
          called.should.equal(0);      // I.e. the cacher handled it.
          res.should.deep.equal(_R0);  // I.e. it came via empty-prediction.
          cb();
        });
      });
    });

    it('for: set to `false`: after no matches for "ab", ' +
       'it still queries for "abc"', function(cb) {
      makeVsmDictionaryStub({ predictEmpties: false });
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called = 0;
        dict.getMatchesForString('abc', {}, (err, res) => {
          called.should.equal(1);  // This means: it happened via a real query.
          cb();
        });
      });
    });

    it('after no matches for "ab", ' +
       'it still queries for "abc" when using different options; ' +
       'i.e. no interference for different options-objects', function(cb) {
      makeVsmDictionaryStub();  // Using the default: `{ predictEmpties: true }`.
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called = 0;
        dict.getMatchesForString('abc', { x: 1 }, (err, res) => {
          called.should.equal(1);
          cb();
        });
      });
    });

    it('still queries for "a" after "" returned no results', function(cb) {
      makeVsmDictionaryStub();
      result = _R0;
      dict.getMatchesForString('', {}, (err, res) => {
        called = 0;
        dict.getMatchesForString('a', {}, (err, res) => {
          called.should.equal(1);
          cb();
        });
      });
    });

    describe('(timing test)', function(cb) {
      // If an `it()`-test throws an error, and it contained a `clock.restore()`,
      // then the clock won't get restored. So we wrap it in this `describe()`.
      beforeEach(function() { clock = sinon.useFakeTimers(); });
      afterEach (function() { clock.restore(); });

      it('also empties `cacheMOEmpties` automatically after `maxAge` ms, ' +
         'after last cache-access', function(cb) {
        makeVsmDictionaryStub({ maxAge: 2000 });

        result = _R0;
        dict.getMatchesForString('ab', {}, () => {}); // Query with empty result.

        clock.tick(1500);
        result = _R1;
        dict.getMatchesForString('xyz', { x: 1 }, () => {});  // Non-empty query.

        clock.tick(1999);  // Now 1500+1999 ms passed since the empty query.
        Object.keys(dict.cacheMOEmpties).length.should.equal(1);  // Still there.
        dict.cacheMOEmpties.should.deep.equal({ '{}': ['ab'] });//(to be precise).

        clock.tick(2);  // Now 2001 ms passed since the last cache access.
        Object.keys(dict.cacheMOEmpties).length.should.equal(0);  // Empty now.
        cb();
      });
    });

  });


  describe('+ Scenario: gets results from real query, ' +
      'then cache, then empty-prediction  ' +
      '[these tests run on the same `dict`]', function() {
    // All tests in this block work on this same dictionary with growing cache!
    before(function() {
      makeVsmDictionaryStub();  // Using the default: `{ predictEmpties: true }`.
    });

    it('returns one match-object for "a", by real querying', function(cb) {
      result = _R1;
      dict.getMatchesForString('a', {}, (err, res) => {
        called.should.equal(1);  // This means: it happened via a real query.
        res.should.deep.equal(_R1);
        cb();
      });
    });

    it('then returns none for "ab", by real querying', function(cb) {
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called.should.equal(1);
        res.should.deep.equal(_R0);
        cb();
      });
    });

    it('then returns none for "ab" (once more)', function(cb) {
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called.should.equal(0); // I.e. it didn't query. The cacher handled it.
        res.should.deep.equal(_R0);
        cb();
      });
    });

    it('then returns none for "abc", and avoids a query ' +
       'that would return no matches anyway', function(cb) {
      result = _R1;  // Will not be used, if empty-prediction is active.
      dict.getMatchesForString('abc', {}, (err, res) => {
        called.should.equal(0);      // I.e. the cacher handled it.
        res.should.deep.equal(_R0);  // I.e. it came via empty-prediction.
        cb();
      });
    });

    it('then returns a different match-object for "abc" ' +
       'when using different options, via query', function(cb) {
      result = _R2;
      dict.getMatchesForString('abc', { x: 1 }, (err, res) => {
        called.should.equal(1);
        res.should.deep.equal(_R2);
        cb();
      });
    });
  });


  describe('callbacks are truly asynchronous, ' +
      'i.e. they get called on the next event-loop', function() {
    var count;

    beforeEach(function() {
      makeVsmDictionaryStub();
      count = 0;
    });

    it('truly-asynchronously returns a normal query result', function(cb) {
      dict.getMatchesForString('a', {}, (err, res) => {
        count.should.equal(1);  // This runs _after_ we set `count` to 1, below.
        cb();
      });
      count = 1;
    });

    it('truly-asynchronously returns a result from the cache', function(cb) {
      dict.getMatchesForString('a', {}, (err, res) => {
        called = 0;
        dict.getMatchesForString('a', {}, (err, res) => {
          called.should.equal(0);  // I.e. the result came from the cache.
          count.should.equal(1);   // I.e. this got executed async'ly.
          cb();
        });
        count = 1;
      });
    });

    it('truly-asynchronously returns an empty result via empty-prediction',
       function(cb) {
      result = _R0;
      dict.getMatchesForString('ab', {}, (err, res) => {
        called = 0;
        result = _R1;  // Will not be used, if empty-prediction is active.
        dict.getMatchesForString('abc', {}, (err, res) => {
          called.should.equal(0);      // I.e. it came from the caching-subclass.
          res.should.deep.equal(_R0);  // I.e. it came via `cacheMOEmpties`.
          count.should.equal(1);       // I.e. this got executed async'ly.
          cb();
        });
        count = 1;
      });
    });

  });

});
