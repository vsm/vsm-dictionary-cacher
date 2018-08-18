const { callAsync, /*getNowTime,*/ deleteOldestCacheItem } = require('./util');
const chai = require('chai');  chai.should();
const expect = chai.expect;


describe('helpers/util.js', function() {
  describe('callAsync()', function() {
    var f = (a, b, cb) => cb(null, a * b);
    var count = 0;

    it('calls a function on the next event loop', function(cb) {
      callAsync(f, 2, 5, (err, ans) => {
        expect(err).to.equal(null);
        ans.should.equal(10);
        count.should.equal(1);
        cb();
      });
      count = 1;  // `f` will only be called after this assignment.
    });
  });

  describe('deleteOldestCacheItem()', function() {
    it('removes the item with the oldest (smallest) `lastAccessed` property ' +
       'from a cache ', function() {
      var cache = {
        a: { value: 1, lastAccessed: 50 },
        b: { value: 2, lastAccessed: 49 },
        c: { value: 3, lastAccessed: 51 }
      };
      deleteOldestCacheItem(cache);
      cache.should.deep.equal({
        a: { value: 1, lastAccessed: 50 },
        c: { value: 3, lastAccessed: 51 }
      });
    });
  });

});
