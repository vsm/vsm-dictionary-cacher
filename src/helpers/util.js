module.exports = { callAsync, getNowTime, deleteOldestCacheItem };


/**
 * Makes a call to `f` with given arguments, in a truly asynchronous way,
 * i.e. on a next event-loop.
 */
function callAsync(f, ...args) {
  setTimeout(() => f(...args), 0);
}


function getNowTime() {
  return (new Date()).getTime();
}


/**
 * Deletes the least recently accessed item in a `cache` that
 * has the format: `{ 'key': { value:.., lastAccessed:.. }, ... }`.
 */
function deleteOldestCacheItem(cache) {
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
