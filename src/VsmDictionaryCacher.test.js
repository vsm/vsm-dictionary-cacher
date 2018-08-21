const cacher = require('./VsmDictionaryCacher');
const VsmDictionaryLocal = require('vsm-dictionary-local');
const sinon = require('sinon');
const chai = require('chai');  chai.should();
const expect = chai.expect;

// Easy log function.
const D = (obj, depth = 4) => console.dir(obj, {depth});  // eslint-disable-line


// Allow callbacks to look like "(err, res) => .." even if not using these args.
/* eslint no-unused-vars: ['error', { 'argsIgnorePattern': '^err|res$' }] */



describe('VsmDictionaryCacher.js', () => {
  var dict;
  var calledEN, calledDI, calledRT, calledMOE, calledMO;
  var callOpts;
  var errEN, errDI, errRT, errMOE;
  var myDelay = 0;
  var count;
  var clock;


  /**
   * + We base tests on a spied-upon VsmDictionaryLocal, by making a subclass of
   *   of it that logs if certain functions were called.
   *   Then, after we wrap the cache around this spy-wrapper, it will log
   *   only those queries that went through to the underlying datastore.
   *   + E.g. the `getEntries()` will set `callEN` to 1 when it gets called,
   *     and set `callOpt`, to report the `options` argument it received.
   *     These log variables get reset before every single call to `getEntries()`,
   *     by a further subclass of the cache-wrapped dictionary (see below).
   *
   * + In addition, we enable this subclass to inject artificial query errors in
   *   its response to the cacher (i.e. as if the query to VDLocal had failed).
   *   + E.g. `getEntries()` will inject an error when it is queried the one
   *     next time (and only then), if `errEN` is set to 1.
   *
   * + Also, a query may be set to use a response delay that is different from
   *   the dictionary's `options.delay`, by making `myDelay` > 0.
   */
  class DictionarySpyAndErr extends VsmDictionaryLocal {
    _err (cb) {
      setTimeout(() => cb('ERR'), myDelay || this.delay);
      myDelay = 0;
    }
    getEntries(options, cb) {
      callOpts = options;
      calledEN = 1;
      errEN ? this._err(cb) : super.getEntries(options, cb);
      errEN = 0;
    }

    getDictInfos(options, cb) {
      callOpts = options;
      calledDI = 1;
      errDI ? this._err(cb) : super.getDictInfos(options, cb);
      errDI = 0;
    }

    getRefTerms(options, cb) {
      calledRT = 1;
      errRT ? this._err(cb) : super.getRefTerms(options, cb);
      errRT = 0;
    }

    getEntryMatchesForString(str, options, cb) {
      calledMOE = 1;
      errMOE ? this._err(cb) : super.getEntryMatchesForString(str, options, cb);
      errMOE = 0;
    }

    getMatchesForString(str, options, cb) {
      calledMO = 1;
      super.getMatchesForString(str, options, cb);
    }
  }


  // DictInfo/entriy/refTerm-data, for a test-VsmDictionaryLocal.
  var di1 = { id: 'A', name: 'Name 1' };
  var di2 = { id: 'B', name: 'Name 2' };
  var di3 = { id: 'C', name: 'Name 3' };
  var di4 = { id: 'D', name: 'Name Z' };
  var di5 = { id: 'E', name: 'Name Y' };

  var e1 = { id: 'A:01', dictID: 'A', terms: [{ str: 'a'   }] };
  var e2 = { id: 'A:02', dictID: 'A', terms: [{ str: 'ab'  }] };
  var e3 = { id: 'B:01', dictID: 'B', terms: [{ str: 'bc'  }] };
  var e4 = { id: 'B:02', dictID: 'B', terms: [{ str: 'bcd' }, { str: 'x' }] };

  var r1 = 'it';
  var r2 = 'that';
  var r3 = 'this';

  // This combines a dictInfo with entries, like VD.Local's `dictData` wants it.
  var addEntries = (di, ...entries) => Object.assign({}, di, { entries });

  function makeDictionary(options = {}, cacheOptions = {}) {
    var DictionaryCached = cacher(DictionarySpyAndErr, cacheOptions);

    /**
     * Make a further subclass that resets `count`/`called-*` before every call.
     * (Note: although `beforeEach()` could reset them, it still does not reset
     *        them between multiple get()-calls in a single `it()` test.)
     */
    class Dictionary extends DictionaryCached {
      getEntries              (...args) { count = calledEN  = callOpts = 0;
        super.getEntries  (...args); }
      getDictInfos            (...args) { count = calledDI  = callOpts = 0;
        super.getDictInfos(...args); }
      getRefTerms             (...args) { count = calledRT  = 0;
        super.getRefTerms (...args); }
      getEntryMatchesForString(...args) { count = calledMOE = 0;
        super.getEntryMatchesForString(...args); }
      getMatchesForString     (...args) { count = calledMO  = 0;
        super.getMatchesForString     (...args); }
      loadFixedTerms          (...args) { count = calledEN = 0;
        super.loadFixedTerms(...args); }
    }

    dict = new Dictionary(Object.assign({}, options, {
      dictData: [
        addEntries(di1, e1, e2),
        addEntries(di2, e3, e4),
        di3,
        di4,
        di5
      ],
      refTerms: [r1, r2, r3]
    }));
  }


  describe('Match-object caching ----------', () => {

    describe('basic caching  [these tests run on the same `dict`]', () => {

      // All tests in this block work on this same dictionary, of which the
      // cache is not cleared but may grow after each operation !
      before(() => {
        makeDictionary();
      });

      it('lets the first call to getMatchesForString() pass through, ' +
         'to let the parent class query', cb => {
        dict.getMatchesForString('a', {}, (err, res) => {
          calledMO.should.equal(1);
          expect(err).to.equal(null);
          res.items.length.should.equal(2);
          cb();
        });
      });

      it('...but uses cached results for a second call ' +
         'with same arguments', cb => {
        dict.getMatchesForString('a', {}, (err, res) => {
          calledMO.should.equal(0);
          expect(err).to.equal(null);
          res.items.length.should.equal(2);
          cb();
        });
      });

      it('does not use cached results for a different search-string', cb => {
        dict.getMatchesForString('ab', {}, (err, res) => {
          calledMO.should.equal(1);
          res.items.length.should.deep.equal(1);
          cb();
        });
      });

      it('...but does so on the second call', cb => {
        dict.getMatchesForString('ab', {}, (err, res) => {
          calledMO.should.equal(0);
          res.items.length.should.deep.equal(1);
          cb();
        });
      });

      it('does not use cached results for a different options object', cb => {
        dict.getMatchesForString('a', { x: 1 }, (err, res) => {
          calledMO.should.equal(1);
          res.items.length.should.deep.equal(2);
          cb();
        });
      });

      it('...but does so on the second call', cb => {
        dict.getMatchesForString('a', { x: 1 }, (err, res) => {
          calledMO.should.equal(0);
          res.items.length.should.deep.equal(2);
          cb();
        });
      });

      it('it can clear the cache', cb => {
        dict.cacheMO.should.not.deep.equal({});
        dict.clearCache();
        dict.cacheMO.should.deep.equal({});
        cb();
      });

      it('repeats the real query after clearing the cache', cb => {
        dict.clearCache();
        dict.getMatchesForString('a', {}, (err, res) => {
          calledMO.should.equal(1);
          expect(err).to.equal(null);
          res.items.length.should.deep.equal(2);
          cb();
        });
      });
    });


    describe('maxItems', () => {
      const _a = 'a{}';  // Cache-key for search-string 'a' and options `{}`.

      beforeEach(() => {
        makeDictionary({}, { maxItems: 1 });
      });

      it('evicts the oldest item when the cache overflows', cb => {
        dict.getMatchesForString('a', {}, (err, res) => {
          expect(dict.cacheMO[_a]).to.not.equal(undefined);  // 'a' is in cache.

          setTimeout(() => {  // Ensure that 2nd addition has a later timestamp.
            dict.getMatchesForString('b', {}, (err, res) => {
              Object.keys(dict.cacheMO).length.should.equal(1); // Still 1 item.
              expect(dict.cacheMO[_a]).to.equal(undefined);  // Now the oldest..
              //                   ..item, 'a', has been evicted from the cache.
              cb();
            });
          }, 2);
        });
      });
    });


    describe('concurrent requests piggy-backing', () => {

      beforeEach(() => {
        makeDictionary({ delay: 100 });  // 100 ms response delay.
        clock = sinon.useFakeTimers();
      });

      afterEach(() => {
        clock.restore();
      });


      it(['if a call 1 takes some time, and meanwhile an identical call 2',
        'and a different call 3 are made, then call 2 is put on hold;',
        'and then when call 1 finishes:',
        'call 2 immediately finishes as well, and reuses call 1\'s result;',
        'but not so for call 3']
        .join('\n          '),
      cb => {
        var res1 = 0;
        var res2 = 0;
        var res3 = 0;
        dict.getMatchesForString('a', {},       (err, res) => { res1 = res });
        dict.cacheMOQueue.should.not.deep.equal({});  // Some `cb`s are waiting.

        clock.tick(99);  // This waits 99 ms before making calls 2 and 3.
        dict.getMatchesForString('a', {},       (err, res) => { res2 = res });
        dict.getMatchesForString('a', { x: 1 }, (err, res) => { res3 = res });

        clock.tick(0);  // This makes any actual query get launched, above.
        res1.should.equal(0);  // Call 1 did not finish before its 100 ms delay.
        res2.should.equal(0);  // Neither did call 2; it's queued after call 1.
        res3.should.equal(0);  // Neither did call 3; it made a 100ms query.

        clock.tick(3);  // This makes 102 ms pass since call 1 was made.
        res1.should.not.equal(0);  // Now call 1 returned its result.
        res2.should.not.equal(0);  // And call 2 returned its result _early_.
        res2.should.deep.equal(res1);
        res3.should    .equal(0);  // But call 3 did not yet return.

        clock.tick(99);
        res3.should.not.equal(0);  // 102 ms after its own query, call 3 returns.

        dict.cacheMOQueue.should.deep.equal({}); // No more queued callbacks now.
        cb();
      });


      it(['if a call 1 takes some time, and meanwhile an identical call 2',
        'is made (which is then put on hold), and then call 1 errors:',
        'then call 2 immediately returns the same error too']
        .join('\n          '),
      cb => {

        dict.getRefTerms = (options, cb) => {  // Make it error, after a delay.
          setTimeout(() => cb('ERR'), 100);
        };
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


    describe('predictEmpties', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('for: default `true`: after no matches for "xy", ' +
         'it avoids a real query for "xyz"', cb => {
        dict.getMatchesForString('xy', {}, (err, res) => {
          calledMO .should.equal(1);  // I.e. there was no cache-hit.
          calledMOE.should.equal(1);  // I.e. empty-prediction did not kick in..
          //                  ..because `getEntryMatchesForString()` got called.

          dict.getMatchesForString('xyz', {}, (err, res) => {
            calledMO .should.equal(1);  // Again, there was no cache-hit.
            calledMOE.should.equal(0);  // But now it came via empty-prediction.
            res.should.deep.equal({ items: [] });
            cb();
          });
        });
      });

      it('for: set to `false`: after no matches for "xy", ' +
         'it still queries for "xyz"', cb => {
        makeDictionary({}, { predictEmpties: false });  // Use custom options.
        dict.getMatchesForString('xy', {}, (err, res) => {
          calledMO .should.equal(1);
          calledMOE.should.equal(1);

          dict.getMatchesForString('xyz', {}, (err, res) => {
            calledMO .should.equal(1);
            calledMOE.should.equal(1);  // This time it launched a real query.
            res.should.deep.equal({ items: [] });
            cb();
          });
        });
      });

      it('after no matches for "xy", ' +
         'it still queries for "xyz" when using different options; ' +
         'i.e. no interference for different options-objects', cb => {
        dict.getMatchesForString('xy', {}, (err, res) => {
          calledMO .should.equal(1);
          calledMOE.should.equal(1);

          dict.getMatchesForString('xyz', { x: 1 }, (err, res) => {
            calledMO .should.equal(1);
            calledMOE.should.equal(1); // Empty-prediction did not kick in here.
            res.should.deep.equal({ items: [] });
            cb();
          });
        });
      });

      it('still queries for "a", after "" returned nothing', cb => {
        dict.getMatchesForString('', {}, (err, res) => {
          calledMO .should.equal(1);
          calledMOE.should.equal(1);

          dict.getMatchesForString('a', {}, (err, res) => {
            calledMO .should.equal(1);
            calledMOE.should.equal(1);  // Empty-prediction did not kick in.
            res.items.length.should.equal(2);
            cb();
          });
        });
      });

      it('still returns a number-string match for "1e3", after "1e" ' +
         'returned nothing (so "1e3" caused a cache-empties hit)', cb => {
        dict.getMatchesForString('1e', {}, (err, res) => {
          res.items.length.should.equal(0);

          dict.getMatchesForString('1e3', {}, (err, res) => {
            res.items.length.should.equal(1);
            cb();
          });
        });
      });

      it('still returns a match for the refTerm "it", after "i" ' +
         'returned nothing', cb => {
        dict.getMatchesForString('i', {}, (err, res) => {
          res.items.length.should.equal(0);

          dict.getMatchesForString('it', {}, (err, res) => {
            res.items.length.should.equal(1);
            cb();
          });
        });
      });

      it('... and then on a second request for that refTerm, ' +
         'gets it from the cache', cb => {
        dict.getMatchesForString('i', {}, (err, res) => {
          res.items.length.should.equal(0);

          dict.getMatchesForString('it', {}, (err, res) => {
            res.items.length.should.equal(1);
            calledMO.should.equal(1);  // `res` did not come from the cache.

            dict.getMatchesForString('it', {}, (err, res) => {
              res.items.length.should.equal(1);
              calledMO.should.equal(0);  // `res` did came from the cache.
              cb();
            });
          });
        });
      });

      it('`clearCache()` clears predictEmpties-related data', cb => {
        dict.getMatchesForString('i', {}, (err, res) => {
          expect(err).to.equal(null);
          res.items.length.should.equal(0);
          Object.keys(dict.cacheMOEmpties).length.should.equal(1);

          dict.clearCache();
          dict.cacheMOEmpties.should.deep.equal({});
          cb();
        });
      });
    });


    describe('callbacks are truly asynchronous, ' +
             'i.e. they get called on the next event-loop', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('truly-asynchronously returns a normal query result', cb => {
        dict.getMatchesForString('a', {}, (err, res) => {
          calledMO.should.equal(1);  // I.e. the result came from a query.
          count.should.equal(1);     // Runs _after_ `count` is set to 1, below.
          cb();
        });
        count = 1;
      });

      it('truly-asynchronously returns a result from the cache', cb => {
        dict.getMatchesForString('a', {}, (err, res) => {

          dict.getMatchesForString('a', {}, (err, res) => {
            calledMO.should.equal(0);  // I.e. the result came from the cache.
            count.should.equal(1);     // I.e. this got executed asynchronously.
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns an empty result ' +
         'via empty-prediction', cb => {
        dict.getMatchesForString('xy', {}, (err, res) => {
          res.items.length.should.equal(0);

          dict.getMatchesForString('xyz', {}, (err, res) => {
            calledMO .should.equal(1);  // I.e. no cache-hit; parent was called.
            calledMOE.should.equal(0);  // I.e. it came via empty-prediction.
            res.items.length.should.equal(0);
            count.should.equal(1);      // I.e. this got executed asynchronously.
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns on error', cb => {
        errMOE = 1;
        dict.getMatchesForString('i', {}, (err, res) => {
          err.should.equal('ERR');
          calledMO.should.equal(1);
          calledMOE.should.equal(1);
          count.should.equal(1);
          cb();
        });
        count = 1;
      });
    });

  });



  describe('RefTerm caching ----------', () => {

    describe('basic caching', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('it returns a refTerm, and fills the cache with all', cb => {
        dict.getRefTerms({ filter: { str: [r1] } }, (err, res) => {
          expect(err).to.equal(null);
          res.items.should.deep.equal([r1]);
          dict.cacheRT.should.deep.equal([r1, r2, r3]);
          cb();
        });
      });

      it('it returns all refTerms, and fills the cache', cb => {
        dict.getRefTerms({}, (err, res) => {
          res.items.should.deep.equal([r1, r2, r3]);
          dict.cacheRT.should.deep.equal([r1, r2, r3]);
          cb();
        });
      });

      it('it returns refTerms on a second call from the cache, ' +
         'and sorts them', cb => {
        dict.getRefTerms({ filter: { str: [r3, r1] } }, (err, res) => {
          res.items.should.deep.equal([r1, r3]);
          calledRT.should.equal(1);

          dict.getRefTerms({ filter: { str: [r2, r1] } }, (err, res) => {
            calledRT.should.equal(0);  // I.e. no query, it came from the cache.
            res.items.should.deep.equal([r1, r2]);
            cb();
          });
        });
      });

      it('it returns a refTerm, and fills the cache, ' +
         'also with `page` and `perPage` options', cb => {
        dict.getRefTerms({ page: 2, perPage: 1 }, (err, res) => {
          res.items.should.deep.equal([r2]);
          dict.cacheRT.should.deep.equal([r1, r2, r3]);
          cb();
        });
      });

      it('it can clear the cache', cb => {
        dict.getRefTerms({ filter: { str: [r1] } }, (err, res) => {
          dict.cacheRT.length.should.equal(3);
          dict.clearCache();
          dict.cacheRT.should.equal(false);
          cb();
        });
      });
    });


    describe('concurrent requests piggy-backing', () => {

      beforeEach(() => {
        makeDictionary({ delay: 100 });  // 100 ms response delay.
        clock = sinon.useFakeTimers();
      });

      afterEach(() => {
        clock.restore();
      });


      it(['if a call 1 takes some time, and meanwhile a call 2 is made,',
        'then call 2 is put on hold;',
        'and then when call 1 finishes, call 2 immediately finishes as well;',
        'and then when a call 3 is made, it gets answered immediately']
        .join('\n          '),
      cb => {
        var res1 = 0;
        var res2 = 0;
        dict.getRefTerms({filter: {str: [r1]}}, (err, res) => { res1 = res });
        dict.cacheRTQueue.length.should.equal(1);  // A `cb` is waiting.

        clock.tick(99);  // This waits 99 ms before making call 2.
        dict.getRefTerms({filter: {str: [r2]}}, (err, res) => { res2 = res });

        clock.tick(0);
        res1.should.equal(0);  // Call 1 did not finish before its 100 ms delay.
        res2.should.equal(0);  // Neither did call 2; it's queued after call 1.
        dict.cacheRTQueue.length.should.equal(2);  // Two `cb`s are waiting.

        clock.tick(2);  // This makes 101 ms pass since call 1 was made.
        res1.items[0].should.equal(r1);  // Now call 1 returned its result.
        res2.items[0].should.equal(r2);  // And call 2 returned _early_.
        dict.cacheRTQueue.length.should.equal(0); // No more queued `cb`s now.

        var res3 = 0;
        dict.getRefTerms({filter: {str: [r3]}}, (err, res) => { res3 = res });
        clock.tick(1);
        res3.items[0].should.equal(r3);  // Call 3 uses cache and returns early.

        cb();
      });


      it(['if a call 1 takes some time, and meanwhile a call 2 is made',
        '(which is then put on hold), and then call 1 errors:',
        'then call 2 immediately returns the same error too;',
        'and then later, a successful call 3 fills the cache']
        .join('\n          '),
      cb => {
        var err1 = 0;
        var err2 = 0;
        errRT = 1;  // Make SpyAndErr's getRefTerms() error on this next call.
        dict.getRefTerms({filter: {str: [r1]}}, (err, res) => { err1 = err });

        clock.tick(99);
        dict.getRefTerms({filter: {str: [r2]}}, (err, res) => { err2 = err });
        err1.should.equal(0);  // Call 1 did not finish before 100 ms delay.
        err2.should.equal(0);  // Neither did call 2.

        clock.tick(3);  // This makes 102 ms pass since call 1 was made.
        err1.should.equal('ERR');  // Now call 1 finished, and reports the error.
        err2.should.equal('ERR');  // And call 2 finished early.
        dict.cacheRT.should.equal(false);  // Cache status has been reset.

        // The second attempt to fill the cache (by call 3) will be successfull.
        var err3 = 0;
        var res3 = 0;
        dict.getRefTerms({filter: {str: [r3]}}, (err, res) => { err3 = err;
          res3 = res; });

        clock.tick(0);
        dict.cacheRT.should.equal(true);  // Cache status is pending.
        err3.should.equal(0);
        res3.should.equal(0);

        clock.tick(102);
        dict.cacheRT.length.should.equal(3);  // Cache is now filled.
        expect(err3).to.equal(null);
        res3.items[0].should.equal(r3);

        cb();
      });
    });


    describe('callbacks are truly asynchronous', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('truly-asynchronously returns a normal query result', cb => {
        dict.getRefTerms({}, (err, res) => {
          calledRT.should.equal(1);  // I.e. the result came from a query.
          count.should.equal(1);
          cb();
        });
        count = 1;
      });

      it('truly-asynchronously returns a result from the cache', cb => {
        dict.getRefTerms({}, (err, res) => {

          dict.getRefTerms({}, (err, res) => {
            calledRT.should.equal(0);  // I.e. the result came from the cache.
            count.should.equal(1);
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns on error', cb => {
        errRT = 1;
        dict.getRefTerms({}, (err, res) => {
          err.should.equal('ERR');
          calledRT.should.equal(1);
          count.should.equal(1);
          cb();
        });
        count = 1;
      });
    });

  });



  describe('DictInfo caching ----------', () => {

    describe('basic caching', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('queries all at 1st request; gets from cache at 2nd request', cb => {
        dict.getDictInfos({}, (err, res) => {
          expect(err).to.equal(null);
          res.should.deep.equal({ items: [di1, di2, di3, di4, di5] });

          dict.getDictInfos({}, (err, res) => {
            expect(err).to.equal(null);
            res.should.deep.equal({ items: [di1, di2, di3, di4, di5] });
            calledDI.should.equal(0);  // I.e. it came from the cache.
            cb();
          });
        });
      });

      it('queries for dictIDs at 1st request; gets from cache at 2nd ' +
         'request; and sorts by ID in both cases', cb => {
        dict.getDictInfos({ filter: { id: ['E', 'D', 'C'] } }, (err, res) => {
          expect(err).to.equal(null);
          res.should.deep.equal({ items: [di3, di4, di5] });

          dict.getDictInfos({ filter: { id: ['D', 'C'] } }, (err, res) => {
            expect(err).to.equal(null);
            res.should.deep.equal({ items: [di3, di4] });
            calledDI.should.equal(0);
            cb();
          });
        });
      });

      it('queries for dictIDs at 1st request; queries some more at 2nd ' +
         'if not all was found in cache', cb => {
        dict.getDictInfos({ filter: { id: ['A', 'B'] } }, (err, res) => {
          expect(err).to.equal(null);
          res.should.deep.equal({ items: [di1, di2] });
          calledDI.should.equal(1);
          callOpts.filter.id.should.deep.equal(['A', 'B']);  // Queried both.

          dict.getDictInfos({ filter: { id: ['B', 'C'] } }, (err, res) => {
            expect(err).to.equal(null);
            res.should.deep.equal({ items: [di2, di3] });
            calledDI.should.equal(1);
            callOpts.filter.id.should.deep.equal(['C']);  // Queried only 'C'.
            cb();
          });
        });
      });

      it('deduplicates requested dictIDs, both for cache-miss and -hit', cb => {
        dict.getDictInfos({filter: {id: ['A','A','B','B','A']}}, (err, res) => {
          expect(err).to.equal(null);
          res.should.deep.equal({ items: [di1, di2] });
          calledDI.should.equal(1);
          callOpts.filter.id.should.deep.equal(['A', 'B']);  // It deduplicated.

          dict.getDictInfos({ filter: { id: ['A', 'A'] } }, (err, res) => {
            expect(err).to.equal(null);
            res.should.deep.equal({ items: [di1] });
            calledDI.should.equal(0);  // No query now, gets it from cache.
            cb();
          });
        });
      });

      it('queries for dict-name, but does not use cache for lookup (but does ' +
         'put the result in it); and sorts by dictID', cb => {
        dict.getDictInfos({filter: {name: ['Name Y', 'Name Z']}}, (err, res) => {
          expect(err).to.equal(null);
          res.should.deep.equal({ items: [di4, di5] });
          Object.keys(dict.cacheDI).length.should.equal(2); // Filled the cache.

          dict.getDictInfos({filter:{name:['Name Y', 'Name Z']}}, (err, res) => {
            expect(err).to.equal(null);
            res.should.deep.equal({ items: [di4, di5] });
            calledDI.should.equal(1); // I.e. it queried; did not use the cache.
            cb();
          });
        });
      });

      it('sort cache-hits either by ID or by name', cb => {
        dict.getDictInfos({ filter: { id: ['E', 'D', 'C'] } }, (err, res) => {
          res.should.deep.equal({ items: [di3, di4, di5] });

          var options = { filter: { id: ['E', 'D'] }, sort: 'id' };
          dict.getDictInfos(options, (err, res) => {
            res.should.deep.equal({ items: [di4, di5] });
            calledDI.should.equal(0);

            options = { filter: { id: ['D', 'E'] }, sort: 'name' };
            dict.getDictInfos(options, (err, res) => {
              res.should.deep.equal({ items: [di5, di4] });
              calledDI.should.equal(0);
              cb();
            });
          });
        });
      });


      it('for a request-by-dictIDs with pagination, removes the pagination ' +
         'before querying, so all requested dictInfos get cached', cb => {
        var options = {filter: {id: ['A', 'B', 'C', 'D']}, page: 3, perPage: 1};
        dict.getDictInfos(options, (err, res) => {
          res.should.deep.equal({ items: [di3] });

          dict.getDictInfos({ filter: { id: ['A', 'C', 'D'] } }, (err, res) => {
            res.should.deep.equal({ items: [di1, di3, di4] });
            calledDI.should.equal(0);  // I.e. no query, it just used the cache.
            cb();
          });
        });
      });

      it('for a request-for-all with pagination, removes the pagination ' +
         'before querying the datastore, so everything gets cached', cb => {
        dict.getDictInfos({ page: 3, perPage: 1 }, (err, res) => {
          res.should.deep.equal({ items: [di3] });

          dict.getDictInfos({ filter: { id: ['A', 'C', 'E'] } }, (err, res) => {
            res.should.deep.equal({ items: [di1, di3, di5] });
            calledDI.should.equal(0);  // It did not query.
            cb();
          });
        });
      });

      it('handles paginated requests, and can use the cache for them', cb => {
        var optAll = {page: 3, perPage: 2};
        var optIDs = {page: 3, perPage: 2, filter: {id: ['A','B','C','D','E']}};

        dict.getDictInfos(optIDs, (err, res) => {
          res.should.deep.equal({ items: [di5] });
          calledDI.should.equal(1);  // Req.-for-IDs is answered after query.

          dict.getDictInfos(optAll, (err, res) => {
            res.should.deep.equal({ items: [di5] });
            calledDI.should.equal(1);  // Req.-for-all is answered after query.

            dict.getDictInfos(optIDs, (err, res) => {
              res.should.deep.equal({ items: [di5] });
              calledDI.should.equal(0);  // Req-for-IDs is answered from cache.

              dict.getDictInfos(optAll, (err, res) => {
                res.should.deep.equal({ items: [di5] });
                calledDI.should.equal(0);  // Req-for-all is answered from cache.
                cb();
              });
            });
          });
        });
      });

      it('handles requests for non-existent dictIDs by leaving them out of ' +
         'the result', cb => {
        dict.getDictInfos({filter: {id: ['A', 'D', 'x']}}, (err, res) => {
          res.should.deep.equal({ items: [di1, di4] });

          dict.getDictInfos({ filter: { id: ['A', 'x', 'y'] } }, (err, res) => {
            res.should.deep.equal({ items: [di1] });
            calledDI.should.equal(1);                  // I.e. it queried for ..
            callOpts.filter.id.should.deep.equal(['y']);   // .. cache-miss 'y'.
            cb();
          });
        });
      });

      it('it caches non-existent dictIDs, so it does not re-query them', cb => {
        dict.getDictInfos({filter: {id: ['A','D', 'x']}}, (err, res) => {
          res.should.deep.equal({ items: [di1, di4] });

          dict.getDictInfos({ filter: { id: ['A', 'x'] } }, (err, res) => {
            res.should.deep.equal({ items: [di1] });
            calledDI.should.equal(0);  // I.e. it didn't query non-existing 'x'.
            cb();
          });
        });
      });

      it('after a request-for-all, queries for nothing anymore, not even for ' +
         'a non-existent dictID', cb => {
        dict.getDictInfos({}, (err, res) => {

          dict.getDictInfos({}, (err, res) => {
            res.items.length.should.equal(5);
            calledDI.should.equal(0);  // No query, just from cache.

            dict.getDictInfos({ filter: { id: ['A', 'x'] } }, (err, res) => {
              res.should.deep.equal({ items: [di1] });
              calledDI.should.equal(0);  // It did not query non-existing 'x'.
              cb();
            });
          });
        });
      });

      it('it can clear the cache', cb => {
        dict.getDictInfos({ filter: { id: ['A', 'x'] } }, (err, res) => {
          dict.getDictInfos({}, (err, res) => {  // First load some data.
            dict.cacheDI       .should.not.deep.equal({});
            dict.cacheDIGotAll .should.not     .equal(0);
            dict.clearCache();
            dict.cacheDI       .should.deep.equal({});
            dict.cacheDIQueried.should.deep.equal({});
            dict.cacheDIGotAll .should     .equal(0);
            cb();
          });
        });
      });

    });


    describe('concurrent requests piggy-backing', () => {

      var res0, res1, res2, res3, res4, res5, res6;
      var err0, err1, err2, err3, err4, err5, err6;

      beforeEach(() => {
        makeDictionary({ delay: 100 });  // 100 ms response delay.
        clock = sinon.useFakeTimers();
        res0 = res1 = res2 = res3 = res4 = res5 = res6 = 0;
        err0 = err1 = err2 = err3 = err4 = err5 = err6 = 0;
      });

      afterEach(() => {
        clock.restore();
      });

      var o = (...args) => ({ filter: { id: [...args] } });


      it(['Requests-for-dictIDs (incl absent one): after a call 0 caches 1 item:',
        'if a call 1 takes some time, and meanwhile a fully dependent call 2',
        'and a partially dependent call 3 are made; then 2&3 are put on hold;',
        'and then when call 1 finishes, call 2 finishes immediately too;',
        'and call 3 (which queried its indep. part only) finishes a bit later;',
        'and then a fully cache-resolvable call 4 finishes immediately']
        .join('\n          '),
      cb => {
        dict.getDictInfos(o('A'          ), (err, res) => { res0 = res });
        clock.tick(99);
        res0.should.equal(0);
        clock.tick(2);  // After 101ms, call 0 returns.
        res0.items.should.deep.equal([di1]);

        // Make call 1;  we call this "Timepoint 0 ms".
        dict.getDictInfos(o('B', 'C', 'x'), (err, res) => { res1 = res });

        clock.tick(50);  // At 50 ms, halfway before call 1 returns, call 2&3.
        dict.getDictInfos(o('B'          ), (err, res) => { res2 = res });
        clock.tick(0);
        calledDI.should.equal(0);  // Call 2 launches no query; waits for cache.

        dict.getDictInfos(o('B', 'D', 'x'), (err, res) => { res3 = res });
        clock.tick(0);
        calledDI.should.equal(1);          // Call 3 does launch a query, but ..
        callOpts.filter.id.should.deep.equal(['D']); // ..just for the new part.
        res1.should.equal(0);
        res2.should.equal(0);
        res3.should.equal(0);

        clock.tick(51);                            // At 101ms total, ..
        res1.items.should.deep.equal([di2, di3]);  // ..call 1 returns, ..
        res2.items.should.deep.equal([di2]);       // ..and call 2 returns, ..
        res3.should.equal(0);                      // ..but not yet call 3.

        clock.tick(50);  // 101ms after its start, call 3 returns.
        res3.items.should.deep.equal([di2, di4]);

        dict.getDictInfos(o('A','B','C','D','x'), (err, res) => { res4 = res });
        clock.tick(0);  // Let the time-travel mechanism let it callback "now".
        res4.items.should.deep.equal([di1, di2, di3, di4]);
        cb();
      });


      it(['Requests-for-dictIDs & -for-all: after a call 0 caches 1 item:',
        'if a req.-for-IDs call 1, and later a req.-for-all call 2 is made,',
        'and later another req-for-IDs call 3 and a req-for-all call 4 are made;',
        'then only when call 2 finishes, call 3 and 4 finish immediately too;',
        'and then another req-for-IDs 5 and a req-for-all 6 finish immediately']
        .join('\n          '),
      cb => {
        dict.getDictInfos(o('A'          ), (err, res) => { res0 = res });
        clock.tick(101);
        res0.items.should.deep.equal([di1]);  // Call 0 returns.

        // Make call 1;  we call this "Timepoint 0".
        dict.getDictInfos(o('B', 'C', 'x'), (err, res) => { res1 = res });

        clock.tick(25);  // Timepoint 25ms.
        dict.getDictInfos({},               (err, res) => { res2 = res });

        clock.tick(25);  // Timepoint 50ms.
        dict.getDictInfos(o('B', 'D', 'x'), (err, res) => { res3 = res });
        dict.getDictInfos({},               (err, res) => { res4 = res });

        clock.tick(51);  // Timepoint 101ms: call 1 returns, but not 2,3,4.
        res1.items.should.deep.equal([di2, di3]);
        res2.should.equal(0);
        res3.should.equal(0);
        res4.should.equal(0);

        clock.tick(25);  // Timepoint 126ms: call 2 returns, and 3&4.
        res2.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res3.items.should.deep.equal([di2, di4]);
        res4.items.should.deep.equal([di1, di2, di3, di4, di5]);

        dict.getDictInfos(o('A', 'C', 'x'), (err, res) => { res5 = res });
        dict.getDictInfos({},               (err, res) => { res6 = res });
        clock.tick(0);  // Let the time-travel mechanism let them callback "now".
        res5.items.should.deep.equal([di1, di3]);
        res6.items.should.deep.equal([di1, di2, di3, di4, di5]);
        cb();
      });


      it(['if req-for-IDs call 1 and call 2 are made, some time apart,',
        'and then a req-for-IDs call 3 that depends fully on both 1 and 2;',
        'then only when both 1 and 2 finish, will 3 finish immediately too']
        .join('\n          '),
      cb => {
        dict.getDictInfos(o('A', 'B'          ), (err, res) => { res1 = res });

        clock.tick(50);  // At 50ms, call 2.
        dict.getDictInfos(o('C', 'D'          ), (err, res) => { res2 = res });

        clock.tick(25);  // At 75ms, call 3.
        dict.getDictInfos(o('A', 'B', 'C', 'D'), (err, res) => { res3 = res });

        clock.tick(26);  // At 101ms, call 1 returns.
        res1.items.should.deep.equal([di1, di2]);
        res2.should.equal(0);
        res3.should.equal(0);

        clock.tick(50);  // At 151ms, call 2 returns, and 3 too.
        res2.items.should.deep.equal([di3, di4]);
        res3.items.should.deep.equal([di1, di2, di3, di4]);
        cb();
      });


      it(['if two req-for-all calls 1 and 2 are made, some time apart,',
        'and then a req-for-IDs call 3;',
        'then when 1 finishes, will 2 and 3 finish immediately too;',
        'and then a req-for-all 4 and a req-for-IDs 5 finish immediately']
        .join('\n          '),
      cb => {
        dict.getDictInfos({},                    (err, res) => { res1 = res });

        clock.tick(50);  // At 50ms, call 2.
        dict.getDictInfos({},                    (err, res) => { res2 = res });

        clock.tick(25);  // At 75ms, call 3.
        dict.getDictInfos(o('C', 'D'          ), (err, res) => { res3 = res });
        clock.tick(0);
        res1.should.equal(0);
        res2.should.equal(0);
        res3.should.equal(0);

        clock.tick(26);  // At 101ms, call 1 returns, and 2&3 too.
        res1.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res2.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res3.items.should.deep.equal([di3, di4]);

        dict.getDictInfos({},                    (err, res) => { res4 = res });
        dict.getDictInfos(o('A', 'E'          ), (err, res) => { res5 = res });
        clock.tick(0);
        res4.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res5.items.should.deep.equal([di1, di5]);
        cb();
      });


      it(['if a req-for-IDs (incl absent ID) call 1 is made, and then a ',
        'partially dependent req-for-IDs (incl absent ID) call 2 is made,',
        'and then a req-for-all call 3 is made, and then a req-for-IDs call 4,',
        'and then the results for 1 come in (but not yet for 2/3/4),',
        'and then the cache is cleared; then calls 2/3/4 will finish as normal']
        .join('\n          '),
      cb => {
        dict.getDictInfos(o('A', 'B', 'x'     ), (err, res) => { res1 = res });

        clock.tick(50);  // At 50ms, call 2.
        dict.getDictInfos(o('C', 'D', 'y'     ), (err, res) => { res2 = res });

        clock.tick(25);  // At 75ms, call 3.
        dict.getDictInfos({},                    (err, res) => { res3 = res });

        clock.tick(15);  // At 90ms, call 4.
        dict.getDictInfos(o('A', 'C', 'E', 'x'), (err, res) => { res4 = res });

        clock.tick(11);  // At 101ms, call 1 returns, but not 2/3/4.
        res1.items.should.deep.equal([di1, di2]);
        res2.should.equal(0);
        res3.should.equal(0);
        res4.should.equal(0);

        clock.tick(10);  // At 111ms, clear the cache.
        dict.clearCache();

        clock.tick(40);  // At 151ms, call 2 returns, but not 3 or 4.
        res2.items.should.deep.equal([di3, di4]);
        res3.should.equal(0);
        res4.should.equal(0);

        clock.tick(25);  // At 175ms, call 3 returns, and 4 too.
        res3.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res4.items.should.deep.equal([di1, di3, di5]);
        cb();
      });


      it(['if a req-for-IDs call 1 is made, and then a dep. req-for-IDs 2,',
        'and then a part. dep. req-for-IDs (incl absent ID) call 3 is made,',
        'and then a req-for-all call 4 is made, and then another req-for-all 5,',
        'and then an independent req-for-IDs 6;',
        'then when call 1 errors, calls 2&3 immediately return the same error,',
        'and some data is correctly reset about these requests;',
        'and calls 4&5&6 finish as normal;',
        'and then both a req-for-IDs and a req-for-all returns immediately']
        .join('\n          '),
      cb => {
        // Test that our DictionarySpyAndErr's error-sending works.
        errDI = 1;  // Make SpyAndErr's getDictInfos() error on its next call.
        dict.getDictInfos(o('A'               ), (err, res) => { err0 = err });
        clock.tick(99);
        err0.should.equal(0);
        clock.tick(2);
        err0.should.equal('ERR');  // It can generate an error indeed.
        errDI.should.equal(0);  // It automatically resets our testError-switch.

        // NOTE: err1 == 0    : request 1's callback was not yet called.
        //       err1 == null : it reported that the request was successful.
        //       err1 == 'ERR': it reported a query error.

        // Make call 1;  we call this "Timepoint 0".
        errDI = 1;
        dict.getDictInfos(o('A', 'B'          ), (err, res) => { err1 = err });

        clock.tick(25);  // At 25ms, call 2.
        dict.getDictInfos(o('B'               ), (err, res) => { err2 = err });

        clock.tick(25);  // At 50ms, call 3.
        dict.getDictInfos(o('B', 'C', 'x'     ), (err, res) => { err3 = err });
        calledDI.should.equal(1);
        callOpts.filter.id.should.deep.equal(['C', 'x']);

        clock.tick(10);  // At 60ms, call 4.
        dict.getDictInfos({},                    (err, res) => { err4 = err });

        clock.tick(10);  // At 70ms, call 5.
        dict.getDictInfos({},                    (err, res) => { err5 = err });

        clock.tick(10);  // At 80ms, call 6.
        dict.getDictInfos(o('E', 'y'          ), (err, res) => { err6 = err });
        calledDI.should.equal(0);

        err1.should.equal(0);
        err2.should.equal(0);
        err3.should.equal(0);

        // There is still data about ongoing requests: IDs A/B/C/x + req-for-all.
        Object.keys(dict.cacheDIQueried).length.should.equal(4);
        dict.cacheDIGotAll.should.not.equal(0);

        clock.tick(21);  // At 101ms, call 1 returns error, and so do 2 and 3.
        err1.should.equal('ERR');
        err2.should.equal('ERR');
        err3.should.equal('ERR');
        err4.should.equal(0);
        err5.should.equal(0);
        err6.should.equal(0);
        dict.cacheDIGotAll.should.equal(0.5);  // Query-for-all is ongoing.

        // The only IDs marked as still being queried now, are 'C' and 'x'.
        // Because 'A'/'B' got reset after the error. And 'E'/'y' were not
        // queried-for as they were requested after (=> depend on) a req-for-all.
        Object.keys(dict.cacheDIQueried).length.should.equal(2);
        dict.cacheDIQueried['C'].should.equal(true);
        dict.cacheDIQueried['x'].should.equal(true);

        // Even though call 1 errored, which made dependent calls 2&3 error too,
        // the part of dictInfos that they queried for, will still arrive.
        clock.tick(50);  // At 151ms, call 2&3's queried parts both came in OK.
        dict.cacheDIQueried.should.deep.equal({});  // No more IDs awaited now.

        clock.tick(25);  // At 176ms, call 4 returns OK, and immediately 5&6 too.
        expect(err4).to.equal(null);
        expect(err5).to.equal(null);
        expect(err6).to.equal(null);
        dict.cacheDIGotAll.should.equal(1);  // We need this for the next test.

        dict.getDictInfos(o('z'   ), (err, res) => { err6 = err; res6 = res });
        clock.tick(0);
        calledDI.should.equal(0);
        expect(err6).to.equal(null);
        res6.items.length.should.equal(0);

        dict.getDictInfos({}       , (err, res) => { err6 = err; res6 = res });
        clock.tick(0);
        calledDI.should.equal(0);
        expect(err6).to.equal(null);
        res6.items.length.should.equal(5);
        cb();
      });


      it(['if a req-for-IDs 1 is made, and then a req-for-all 2,',
        'and then a dep.(on 1) req-for-IDs 3, and then an indep. req-for-IDs 4;',
        'and then the req-for-IDs 1 errors;',
        'then 2&3&4 finish as normal, as they can use req-for-all 2\'s result']
        .join('\n          '),
      cb => {
        errDI = 1;       // Make call 1 error.
        dict.getDictInfos(o('A','B','x'), (err,res) => {err1 = err; res1 = res});

        clock.tick(10);  // At 10ms, call 2.
        dict.getDictInfos({},             (err,res) => {err2 = err; res2 = res});

        clock.tick(10);  // At 20ms, call 3.
        dict.getDictInfos(o('A','C','x'), (err,res) => {err3 = err; res3 = res});

        clock.tick(10);  // At 30ms, call 4.
        dict.getDictInfos(o('E','y'    ), (err,res) => {err4 = err; res4 = res});
        err1.should.equal(0);
        err2.should.equal(0);
        err3.should.equal(0);
        err4.should.equal(0);

        clock.tick(71);  // At 101ms, call 1 errors, an no others.
        err1.should.equal('ERR');
        err2.should.equal(0);
        err3.should.equal(0);
        err4.should.equal(0);

        clock.tick(10);  // At 111ms, call 2 finishes, and 3&4 immediately too.
        expect(err2).to.equal(null);
        expect(err3).to.equal(null);
        expect(err4).to.equal(null);
        res2.items.should.deep.equal([di1, di2, di3, di4, di5]);
        res3.items.should.deep.equal([di1, di3]);
        res4.items.should.deep.equal([di5]);
        cb();
      });


      it(['if a req-for-IDs 1 is made, and then a req-for-all 2,',
        'and then a req-for-IDs 3, and then a (subset of req 1) req-for-all 4,',
        'and then the req-for-all 2 errors first;',
        'then 3 and 4 immediately error too (as they depend on 2),',
        'but 1 finishes as normal']
        .join('\n          '),
      cb => {
        dict.getDictInfos(o('A','B','x'), (err,res) => {err1 = err; res1 = res});

        clock.tick(10);  // At 10ms, call 2. This will finish..
        myDelay = 50;    // .. 50ms later, so before calls 1/3/4 will, ..
        errDI = 1;       // .. and it error as well.
        dict.getDictInfos({},             (err,res) => {err2 = err; res2 = res});

        clock.tick(10);  // At 20ms, call 3.
        dict.getDictInfos(o('A','C','x'), (err,res) => {err3 = err; res3 = res});

        clock.tick(10);  // At 30ms, call 4.
        dict.getDictInfos(o('A'        ), (err,res) => {err4 = err; res4 = res});
        err1.should.equal(0);
        err2.should.equal(0);
        err3.should.equal(0);
        err4.should.equal(0);

        clock.tick(31);  // At 61ms, call 2 errors, and also 3&4. But not 1.
        err1.should.equal(0);
        err2.should.equal('ERR');
        err3.should.equal('ERR');
        err4.should.equal('ERR');

        clock.tick(40);  // At 101ms, call 1 finishes as normal.
        expect(err1).to.equal(null);
        res1.items.should.deep.equal([di1, di2]);
        cb();
      });
    });


    describe('callbacks are truly asynchronous', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('truly-asynchronously returns a query result, for dictIDs', cb => {
        dict.getDictInfos({ filter: { id: ['A'] } }, (err, res) => {
          calledDI.should.equal(1);  // I.e. the result came from a query.
          count.should.equal(1);     // I.e. this got executed asynchronously.
          cb();
        });
        count = 1;
      });

      it('truly-asynchronously returns a query result, for all', cb => {
        dict.getDictInfos({}, (err, res) => {
          calledDI.should.equal(1);  // I.e. the result came from a query.
          count.should.equal(1);     // I.e. this got executed asynchronously.
          cb();
        });
        count = 1;
      });

      it('truly-asynchronously returns a result from cache, for dictIDs', cb => {
        dict.getDictInfos({ filter: { id: ['A'] } }, (err, res) => {
          dict.getDictInfos({ filter: { id: ['A'] } }, (err, res) => {
            calledDI.should.equal(0);  // I.e. the result came from the cache.
            count.should.equal(1);     // I.e. this got executed asynchronously.
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns a result from cache, for all', cb => {
        dict.getDictInfos({}, (err, res) => {
          dict.getDictInfos({}, (err, res) => {
            calledDI.should.equal(0);  // I.e. the result came from the cache.
            count.should.equal(1);     // I.e. this got executed asynchronously.
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns on error', cb => {
        errDI = 1;
        dict.getDictInfos({ filter: { id: ['A'] } }, (err, res) => {
          err.should.equal('ERR');
          calledDI.should.equal(1);
          count.should.equal(1);

          errDI = 1;
          dict.getDictInfos({}, (err, res) => {
            err.should.equal('ERR');
            calledDI.should.equal(1);
            count.should.equal(2);
            cb();
          });
          count = 2;

        });
        count = 1;
      });
    });

  });



  describe('FixedTerms-loading cache enhancement ----------', () => {

    describe('basic caching  [these tests run on the same `dict`]', () => {

      // All tests in this block work on this same dictionary, of which the
      // cache is not cleared but may grow after each operation !

      before(() => {
        makeDictionary();
      });

      it('loads fixedTerms', cb => {
        var idts = [
          {id: 'B:01'},            // => match-object for entry e3's 1st term.
          {id: 'xx'}               // => no match-object.
        ];
        dict.loadFixedTerms(idts, {}, err => {
          expect(err).to.equal(null);
          calledEN.should.equal(1);
          callOpts.filter.id.should.deep.equal(['B:01', 'xx']);
          Object.keys(dict.fixedTermsCache).length.should.equal(1);
          cb();
        });
      });

      it('adds new fixedTerms', cb => {
        var idts = [
          {id: 'B:02', str: 'x'},  // => match-object for entry e4's 2nd term.
        ];
        dict.loadFixedTerms(idts, {}, err => {
          calledEN.should.equal(1);
          callOpts.filter.id.should.deep.equal(['B:02']);
          Object.keys(dict.fixedTermsCache).length.should.equal(2);
          cb();
        });
      });

      it('adds new fixedTerms, and omits ones queried before, ' +
         'including nonexistent fixedTerms', cb => {
        var idts = [
          {id: 'A:01', str: 'a'},  // => match-object for entry e1's 1st term.
          {id: 'B:02'},            // => match-object for entry e4's 1st term.
          {id: 'B:02', str: 'x'},  // Was loaded before.
          {id: 'xx'},              // Was queried before, but is nonexistent!
          {id: 'yy'}               // => Not queried, will turn out nonexistent.
        ];
        dict.loadFixedTerms(idts, {}, err => {
          calledEN.should.equal(1);
          callOpts.filter.id.should.deep.equal(['A:01', 'B:02', 'yy']);
          Object.keys(dict.fixedTermsCache).length.should.equal(4);
          cb();
        });
      });

      it('does not query if all fixedTerms were received before', cb => {
        var idts = [
          {id: 'A:01', str: 'a'},  // Was loaded before.
          {id: 'B:02'},            // Was loaded before.
        ];
        dict.loadFixedTerms(idts, {}, err => {
          calledEN.should.equal(0);
          Object.keys(dict.fixedTermsCache).length.should.equal(4);
          cb();
        });
      });

      it('clears cacheFT-related data after queries finish; ' +
         'but remembers queried, nonexistent fixedTerms', cb => {
        // Note: there is no real 'cacheFT'. The real cache is the parent's
        // `fixedTermsCache`, which is unchanged by this extra caching layer.
        var key1 = dict._idtToFTCacheKey('xx'); // Key for this nonexistent one.
        var key2 = dict._idtToFTCacheKey('yy');
        dict.cacheFTQueried.should.deep.equal({ [key1]: 0, [key2]: 0 });
        dict.cacheFTQueue  .should.deep.equal([]);
        cb();
      });

      it('clearCache() does not clear the parent\'s `fixedTermsCache`, ' +
         'but forgets about nonexistent fixedTerms', cb => {
        dict.cacheFTQueried.should.not.deep.equal({});
        dict.clearCache();
        dict.fixedTermsCache.should.not.deep.equal({});
        dict.cacheFTQueried.should.deep.equal({});
        cb();
      });
    });


    describe('concurrent requests', () => {

      var err1, err2, err3, err4, err5, err6;

      beforeEach(() => {
        makeDictionary({ delay: 100 });  // 100 ms response delay.
        clock = sinon.useFakeTimers();
        err1 = err2 = err3 = err4 = err5 = err6 = 0;
      });

      afterEach(() => {
        clock.restore();
      });

      // Returns for given entries, a list of idts (with as str their 1st term).
      var o = (...args) => args.map(e =>
        e ?  ({ id: e.id, str: e.terms[0].str }) :  { id: 'x' }
      );

      it(['if a call 1 takes some time, and meanwhile',
        'a fully dependent call 2 and a partially dep. call 3 (incl nonexist. ID)',
        'are made, an then a call 4 that fully depends on all is made;',
        'then when call 1 finishes, call 2 finishes too, but not 3;',
        'and when call 3 finishes, call 4 finishes too;',
        'and then a fully dependent call 5 finishes immediately']
        .join('\n          '),
      cb => {
        dict.loadFixedTerms(o(e1, e2),              {}, err => { err1 = err });
        calledEN.should.equal(1);
        callOpts.filter.id.should.deep.equal([e1.id, e2.id]);

        clock.tick(50);  // At 50ms, call 2 and call 3.
        dict.loadFixedTerms(o(e1),                  {}, err => { err2 = err });
        clock.tick(0);
        calledEN.should.equal(0);  // It does not need to query.
        err2.should.equal(0);  // But waits for calls it depends on to finish.

        dict.loadFixedTerms(o(e2, e3, 0),           {}, err => { err3 = err });
        calledEN.should.equal(1);
        callOpts.filter.id.should.deep.equal([e3.id, 'x']); // Queries new ones.

        clock.tick(25);  // At 75ms, call 4.
        dict.loadFixedTerms(o(e1, e2, e3),          {}, err => { err4 = err });
        clock.tick(0);
        calledEN.should.equal(0);

        err1.should.equal(0);  // I.e. call 1 did not finish yet.
        err2.should.equal(0);
        err3.should.equal(0);
        err4.should.equal(0);
        err5.should.equal(0);

        clock.tick(26);  // At 101ms, call 1 finishes, and also 2.
        expect(err1).to.equal(null);  // I.e. call 1 finished OK.
        expect(err2).to.equal(null);
        err3.should.equal(0);
        err4.should.equal(0);
        Object.keys(dict.fixedTermsCache).length.should.equal(2);

        clock.tick(50);  // At 151ms, call 3 finishes, and also 4.
        expect(err3).to.equal(null);
        expect(err4).to.equal(null);
        Object.keys(dict.fixedTermsCache).length.should.equal(3); // For e1/2/3.
        Object.keys(dict.cacheFTQueried).length.should.equal(1);  // It has 'x'.

        err5.should.equal(0);
        dict.loadFixedTerms(o(e1, e2, e3),          {}, err => { err5 = err });
        clock.tick(0);
        calledEN.should.equal(0);
        expect(err5).to.equal(null);
        cb();
      });


      it(['if a call 1 is made, and them a partially dependent call 2,',
        'and then call 1 finishes, and then the cache is cleared;',
        'then call 2 will finish as normal']
        .join('\n          '),
      cb => {
        dict.loadFixedTerms(o(e1, e2),              {}, err => { err1 = err });

        clock.tick(50);  // At 50ms, call 2.
        dict.loadFixedTerms(o(e2, e3),              {}, err => { err2 = err });

        clock.tick(51);  // At 101ms, call 1 finishes.
        expect(err1).to.equal(null);

        dict.clearCache();

        clock.tick(48);  // At 151ms (not yet at 149ms), call 2 finishes OK.
        err2.should.equal(0);
        clock.tick(2);
        expect(err2).to.equal(null);
        Object.keys(dict.fixedTermsCache).length.should.equal(3);
        Object.keys(dict.cacheFTQueried).length.should.equal(0);
        cb();
      });


      it(['if a call 1 is made, and later a fully dependent call 2,',
        'a partially dependent call 3, an independent call 4 (fully dep. on 3),',
        'an indep. call 5 (part. dep. on 3), and an indep. call 6 are made;',
        'then if call 1 errors, then 2&3 error too, but 4&5&6 finish as normal']
        .join('\n          '),
      cb => {
        errEN = 1;  // Make SpyAndErr's getEntries() report error for next call.
        dict.loadFixedTerms(o(e1),     {}, err => { err1 = err });

        clock.tick(50);  // At 50ms, call 2&3&4.
        dict.loadFixedTerms(o(e1),     {}, err => { err2 = err });
        dict.loadFixedTerms(o(e1, e2), {}, err => { err3 = err });
        dict.loadFixedTerms(o(e2),     {}, err => { err4 = err });
        dict.loadFixedTerms(o(e2, e3), {}, err => { err5 = err });
        dict.loadFixedTerms(o(e4,  0), {}, err => { err6 = err });

        clock.tick(49);  // At 101ms (not 99ms), calls 1&2&3 finish with error.
        err1.should.equal(0);
        clock.tick(2);
        expect(err1).to.equal('ERR');
        expect(err2).to.equal('ERR');
        expect(err3).to.equal('ERR');
        err4.should.equal(0);
        err5.should.equal(0);
        err6.should.equal(0);

        clock.tick(50);  // At 151ms, calls 4&5&6 finish OK.
        expect(err4).to.equal(null);
        expect(err5).to.equal(null);
        expect(err6).to.equal(null);

        Object.keys(dict.fixedTermsCache).length.should.equal(3); // For e1/2/3.
        Object.keys(dict.cacheFTQueried).length.should.equal(1);  // It has 'x'.
        dict.cacheFTQueue.should.deep.equal([]);
        cb();
      });
    });


    describe('callbacks are truly asynchronous', () => {

      beforeEach(() => {
        makeDictionary();
      });

      it('truly-asynchronously returns after querying', cb => {
        dict.loadFixedTerms([{ id: 'A:01', str: 'a' }], {}, (err, res) => {
          calledEN.should.equal(1);  // I.e. the result came from a query.
          count.should.equal(1);
          cb();
        });
        count = 1;
      });

      it('truly-asynchronously returns after using only the cache', cb => {
        dict.loadFixedTerms([{ id: 'A:01', str: 'a' }], {}, (err, res) => {
          calledEN.should.equal(1);

          dict.loadFixedTerms([{ id: 'A:01', str: 'a' }], {}, (err, res) => {
            calledEN.should.equal(0);  // I.e. the result came from the cache.
            count.should.equal(1);
            cb();
          });
          count = 1;
        });
      });

      it('truly-asynchronously returns on error', cb => {
        errEN = 1;
        dict.loadFixedTerms([{ id: 'A:01', str: 'a' }], {}, (err, res) => {
          err.should.equal('ERR');
          calledEN.should.equal(1);
          count.should.equal(1);
          cb();
        });
        count = 1;
      });
    });

  });

});
