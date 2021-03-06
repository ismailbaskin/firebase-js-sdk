/**
* Copyright 2017 Google Inc.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
goog.provide('fb.core.SyncTree');
goog.require('fb.core.Operation');
goog.require('fb.core.SyncPoint');
goog.require('fb.core.WriteTree');
goog.require('fb.core.util');

/**
 * @typedef {{
 *   startListening: function(
 *     !fb.api.Query,
 *     ?number,
 *     function():string,
 *     function(!string, *):!Array.<!fb.core.view.Event>
 *   ):!Array.<!fb.core.view.Event>,
 *
 *   stopListening: function(!fb.api.Query, ?number)
 * }}
 */
fb.core.ListenProvider;

/**
 * SyncTree is the central class for managing event callback registration, data caching, views
 * (query processing), and event generation.  There are typically two SyncTree instances for
 * each Repo, one for the normal Firebase data, and one for the .info data.
 *
 * It has a number of responsibilities, including:
 *  - Tracking all user event callbacks (registered via addEventRegistration() and removeEventRegistration()).
 *  - Applying and caching data changes for user set(), transaction(), and update() calls
 *    (applyUserOverwrite(), applyUserMerge()).
 *  - Applying and caching data changes for server data changes (applyServerOverwrite(),
 *    applyServerMerge()).
 *  - Generating user-facing events for server and user changes (all of the apply* methods
 *    return the set of events that need to be raised as a result).
 *  - Maintaining the appropriate set of server listens to ensure we are always subscribed
 *    to the correct set of paths and queries to satisfy the current set of user event
 *    callbacks (listens are started/stopped using the provided listenProvider).
 *
 * NOTE: Although SyncTree tracks event callbacks and calculates events to raise, the actual
 * events are returned to the caller rather than raised synchronously.
 *
 * @constructor
 * @param {!fb.core.ListenProvider} listenProvider Used by SyncTree to start / stop listening
 *   to server data.
 */
fb.core.SyncTree = function(listenProvider) {
  /**
   * Tree of SyncPoints.  There's a SyncPoint at any location that has 1 or more views.
   * @type {!fb.core.util.ImmutableTree.<!fb.core.SyncPoint>}
   * @private
   */
  this.syncPointTree_ = fb.core.util.ImmutableTree.Empty;

  /**
   * A tree of all pending user writes (user-initiated set()'s, transaction()'s, update()'s, etc.).
   * @type {!fb.core.WriteTree}
   * @private
   */
  this.pendingWriteTree_ = new fb.core.WriteTree();
  this.tagToQueryMap_ = {};
  this.queryToTagMap_ = {};
  this.listenProvider_ = listenProvider;
};


/**
 * Apply the data changes for a user-generated set() or transaction() call.
 *
 * @param {!fb.core.util.Path} path
 * @param {!fb.core.snap.Node} newData
 * @param {number} writeId
 * @param {boolean=} visible
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyUserOverwrite = function(path, newData, writeId, visible) {
  // Record pending write.
  this.pendingWriteTree_.addOverwrite(path, newData, writeId, visible);

  if (!visible) {
    return [];
  } else {
    return this.applyOperationToSyncPoints_(
        new fb.core.operation.Overwrite(fb.core.OperationSource.User, path, newData));
  }
};

/**
 * Apply the data from a user-generated update() call
 *
 * @param {!fb.core.util.Path} path
 * @param {!Object.<string, !fb.core.snap.Node>} changedChildren
 * @param {!number} writeId
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyUserMerge = function(path, changedChildren, writeId) {
  // Record pending merge.
  this.pendingWriteTree_.addMerge(path, changedChildren, writeId);

  var changeTree = fb.core.util.ImmutableTree.fromObject(changedChildren);

  return this.applyOperationToSyncPoints_(
      new fb.core.operation.Merge(fb.core.OperationSource.User, path, changeTree));
};

/**
 * Acknowledge a pending user write that was previously registered with applyUserOverwrite() or applyUserMerge().
 *
 * @param {!number} writeId
 * @param {boolean=} revert True if the given write failed and needs to be reverted
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.ackUserWrite = function(writeId, revert) {
  revert = revert || false;

  var write = this.pendingWriteTree_.getWrite(writeId);
  var needToReevaluate = this.pendingWriteTree_.removeWrite(writeId);
  if (!needToReevaluate) {
    return [];
  } else {
    var affectedTree = fb.core.util.ImmutableTree.Empty;
    if (write.snap != null) { // overwrite
      affectedTree = affectedTree.set(fb.core.util.Path.Empty, true);
    } else {
      fb.util.obj.foreach(write.children, function(pathString, node) {
        affectedTree = affectedTree.set(new fb.core.util.Path(pathString), node);
      });
    }
    return this.applyOperationToSyncPoints_(new fb.core.operation.AckUserWrite(write.path, affectedTree, revert));
  }
};

/**
 * Apply new server data for the specified path..
 *
 * @param {!fb.core.util.Path} path
 * @param {!fb.core.snap.Node} newData
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyServerOverwrite = function(path, newData) {
  return this.applyOperationToSyncPoints_(
      new fb.core.operation.Overwrite(fb.core.OperationSource.Server, path, newData));
};

/**
 * Apply new server data to be merged in at the specified path.
 *
 * @param {!fb.core.util.Path} path
 * @param {!Object.<string, !fb.core.snap.Node>} changedChildren
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyServerMerge = function(path, changedChildren) {
  var changeTree = fb.core.util.ImmutableTree.fromObject(changedChildren);

  return this.applyOperationToSyncPoints_(
      new fb.core.operation.Merge(fb.core.OperationSource.Server, path, changeTree));
};

/**
 * Apply a listen complete for a query
 *
 * @param {!fb.core.util.Path} path
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyListenComplete = function(path) {
  return this.applyOperationToSyncPoints_(
      new fb.core.operation.ListenComplete(fb.core.OperationSource.Server, path));
};

/**
 * Apply new server data for the specified tagged query.
 *
 * @param {!fb.core.util.Path} path
 * @param {!fb.core.snap.Node} snap
 * @param {!number} tag
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyTaggedQueryOverwrite = function(path, snap, tag) {
  var queryKey = this.queryKeyForTag_(tag);
  if (queryKey != null) {
    var r = this.parseQueryKey_(queryKey);
    var queryPath = r.path, queryId = r.queryId;
    var relativePath = fb.core.util.Path.relativePath(queryPath, path);
    var op = new fb.core.operation.Overwrite(fb.core.OperationSource.forServerTaggedQuery(queryId),
        relativePath, snap);
    return this.applyTaggedOperation_(queryPath, queryId, op);
  } else {
    // Query must have been removed already
    return [];
  }
};

/**
 * Apply server data to be merged in for the specified tagged query.
 *
 * @param {!fb.core.util.Path} path
 * @param {!Object.<string, !fb.core.snap.Node>} changedChildren
 * @param {!number} tag
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyTaggedQueryMerge = function(path, changedChildren, tag) {
  var queryKey = this.queryKeyForTag_(tag);
  if (queryKey) {
    var r = this.parseQueryKey_(queryKey);
    var queryPath = r.path, queryId = r.queryId;
    var relativePath = fb.core.util.Path.relativePath(queryPath, path);
    var changeTree = fb.core.util.ImmutableTree.fromObject(changedChildren);
    var op = new fb.core.operation.Merge(fb.core.OperationSource.forServerTaggedQuery(queryId),
        relativePath, changeTree);
    return this.applyTaggedOperation_(queryPath, queryId, op);
  } else {
    // We've already removed the query. No big deal, ignore the update
    return [];
  }
};

/**
 * Apply a listen complete for a tagged query
 *
 * @param {!fb.core.util.Path} path
 * @param {!number} tag
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.applyTaggedListenComplete = function(path, tag) {
  var queryKey = this.queryKeyForTag_(tag);
  if (queryKey) {
    var r = this.parseQueryKey_(queryKey);
    var queryPath = r.path, queryId = r.queryId;
    var relativePath = fb.core.util.Path.relativePath(queryPath, path);
    var op = new fb.core.operation.ListenComplete(fb.core.OperationSource.forServerTaggedQuery(queryId),
        relativePath);
    return this.applyTaggedOperation_(queryPath, queryId, op);
  } else {
    // We've already removed the query. No big deal, ignore the update
    return [];
  }
};

/**
 * Add an event callback for the specified query.
 *
 * @param {!fb.api.Query} query
 * @param {!fb.core.view.EventRegistration} eventRegistration
 * @return {!Array.<!fb.core.view.Event>} Events to raise.
 */
fb.core.SyncTree.prototype.addEventRegistration = function(query, eventRegistration) {
  var path = query.path;

  var serverCache = null;
  var foundAncestorDefaultView = false;
  // Any covering writes will necessarily be at the root, so really all we need to find is the server cache.
  // Consider optimizing this once there's a better understanding of what actual behavior will be.
  this.syncPointTree_.foreachOnPath(path, function(pathToSyncPoint, sp) {
    var relativePath = fb.core.util.Path.relativePath(pathToSyncPoint, path);
    serverCache = serverCache || sp.getCompleteServerCache(relativePath);
    foundAncestorDefaultView = foundAncestorDefaultView || sp.hasCompleteView();
  });
  var syncPoint = this.syncPointTree_.get(path);
  if (!syncPoint) {
    syncPoint = new fb.core.SyncPoint();
    this.syncPointTree_ = this.syncPointTree_.set(path, syncPoint);
  } else {
    foundAncestorDefaultView = foundAncestorDefaultView || syncPoint.hasCompleteView();
    serverCache = serverCache || syncPoint.getCompleteServerCache(fb.core.util.Path.Empty);
  }

  var serverCacheComplete;
  if (serverCache != null) {
    serverCacheComplete = true;
  } else {
    serverCacheComplete = false;
    serverCache = fb.core.snap.EMPTY_NODE;
    var subtree = this.syncPointTree_.subtree(path);
    subtree.foreachChild(function(childName, childSyncPoint) {
      var completeCache = childSyncPoint.getCompleteServerCache(fb.core.util.Path.Empty);
      if (completeCache) {
        serverCache = serverCache.updateImmediateChild(childName, completeCache);
      }
    });
  }

  var viewAlreadyExists = syncPoint.viewExistsForQuery(query);
  if (!viewAlreadyExists && !query.getQueryParams().loadsAllData()) {
    // We need to track a tag for this query
    var queryKey = this.makeQueryKey_(query);
    fb.core.util.assert(!goog.object.containsKey(this.queryToTagMap_, queryKey),
      'View does not exist, but we have a tag');
    var tag = fb.core.SyncTree.getNextQueryTag_();
    this.queryToTagMap_[queryKey] = tag;
    // Coerce to string to avoid sparse arrays.
    this.tagToQueryMap_['_' + tag] = queryKey;
  }
  var writesCache = this.pendingWriteTree_.childWrites(path);
  var events = syncPoint.addEventRegistration(query, eventRegistration, writesCache, serverCache, serverCacheComplete);
  if (!viewAlreadyExists && !foundAncestorDefaultView) {
    var view = /** @type !fb.core.view.View */ (syncPoint.viewForQuery(query));
    events = events.concat(this.setupListener_(query, view));
  }
  return events;
};

/**
 * Remove event callback(s).
 *
 * If query is the default query, we'll check all queries for the specified eventRegistration.
 * If eventRegistration is null, we'll remove all callbacks for the specified query/queries.
 *
 * @param {!fb.api.Query} query
 * @param {?fb.core.view.EventRegistration} eventRegistration If null, all callbacks are removed.
 * @param {Error=} cancelError If a cancelError is provided, appropriate cancel events will be returned.
 * @return {!Array.<!fb.core.view.Event>} Cancel events, if cancelError was provided.
 */
fb.core.SyncTree.prototype.removeEventRegistration = function(query, eventRegistration, cancelError) {
  // Find the syncPoint first. Then deal with whether or not it has matching listeners
  var path = query.path;
  var maybeSyncPoint = this.syncPointTree_.get(path);
  var cancelEvents = [];
  // A removal on a default query affects all queries at that location. A removal on an indexed query, even one without
  // other query constraints, does *not* affect all queries at that location. So this check must be for 'default', and
  // not loadsAllData().
  if (maybeSyncPoint && (query.queryIdentifier() === 'default' || maybeSyncPoint.viewExistsForQuery(query))) {
    /**
     * @type {{removed: !Array.<!fb.api.Query>, events: !Array.<!fb.core.view.Event>}}
     */
    var removedAndEvents = maybeSyncPoint.removeEventRegistration(query, eventRegistration, cancelError);
    if (maybeSyncPoint.isEmpty()) {
      this.syncPointTree_ = this.syncPointTree_.remove(path);
    }
    var removed = removedAndEvents.removed;
    cancelEvents = removedAndEvents.events;
    // We may have just removed one of many listeners and can short-circuit this whole process
    // We may also not have removed a default listener, in which case all of the descendant listeners should already be
    // properly set up.
    //
    // Since indexed queries can shadow if they don't have other query constraints, check for loadsAllData(), instead of
    // queryId === 'default'
    var removingDefault = -1 !== goog.array.findIndex(removed, function(query) {
      return query.getQueryParams().loadsAllData();
    });
    var covered = this.syncPointTree_.findOnPath(path, function(relativePath, parentSyncPoint) {
      return parentSyncPoint.hasCompleteView();
    });

    if (removingDefault && !covered) {
      var subtree = this.syncPointTree_.subtree(path);
      // There are potentially child listeners. Determine what if any listens we need to send before executing the
      // removal
      if (!subtree.isEmpty()) {
        // We need to fold over our subtree and collect the listeners to send
        var newViews = this.collectDistinctViewsForSubTree_(subtree);

        // Ok, we've collected all the listens we need. Set them up.
        for (var i = 0; i < newViews.length; ++i) {
          var view = newViews[i], newQuery = view.getQuery();
          var listener = this.createListenerForView_(view);
          this.listenProvider_.startListening(this.queryForListening_(newQuery), this.tagForQuery_(newQuery),
              listener.hashFn, listener.onComplete);
        }
      } else {
        // There's nothing below us, so nothing we need to start listening on
      }
    }
    // If we removed anything and we're not covered by a higher up listen, we need to stop listening on this query
    // The above block has us covered in terms of making sure we're set up on listens lower in the tree.
    // Also, note that if we have a cancelError, it's already been removed at the provider level.
    if (!covered && removed.length > 0 && !cancelError) {
      // If we removed a default, then we weren't listening on any of the other queries here. Just cancel the one
      // default. Otherwise, we need to iterate through and cancel each individual query
      if (removingDefault) {
        // We don't tag default listeners
        var defaultTag = null;
        this.listenProvider_.stopListening(this.queryForListening_(query), defaultTag);
      } else {
        var self = this;
        goog.array.forEach(removed, function(queryToRemove) {
          var queryIdToRemove = queryToRemove.queryIdentifier();
          var tagToRemove = self.queryToTagMap_[self.makeQueryKey_(queryToRemove)];
          self.listenProvider_.stopListening(self.queryForListening_(queryToRemove), tagToRemove);
        });
      }
    }
    // Now, clear all of the tags we're tracking for the removed listens
    this.removeTags_(removed);
  } else {
    // No-op, this listener must've been already removed
  }
  return cancelEvents;
};

/**
 * Returns a complete cache, if we have one, of the data at a particular path. The location must have a listener above
 * it, but as this is only used by transaction code, that should always be the case anyways.
 *
 * Note: this method will *include* hidden writes from transaction with applyLocally set to false.
 * @param {!fb.core.util.Path} path The path to the data we want
 * @param {Array.<number>=} writeIdsToExclude A specific set to be excluded
 * @return {?fb.core.snap.Node}
 */
fb.core.SyncTree.prototype.calcCompleteEventCache = function(path, writeIdsToExclude) {
  var includeHiddenSets = true;
  var writeTree = this.pendingWriteTree_;
  var serverCache = this.syncPointTree_.findOnPath(path, function(pathSoFar, syncPoint) {
    var relativePath = fb.core.util.Path.relativePath(pathSoFar, path);
    var serverCache = syncPoint.getCompleteServerCache(relativePath);
    if (serverCache) {
      return serverCache;
    }
  });
  return writeTree.calcCompleteEventCache(path, serverCache, writeIdsToExclude, includeHiddenSets);
};

/**
 * This collapses multiple unfiltered views into a single view, since we only need a single
 * listener for them.
 *
 * @param {!fb.core.util.ImmutableTree.<!fb.core.SyncPoint>} subtree
 * @return {!Array.<!fb.core.view.View>}
 * @private
 */
fb.core.SyncTree.prototype.collectDistinctViewsForSubTree_ = function(subtree) {
  return subtree.fold(function(relativePath, maybeChildSyncPoint, childMap) {
    if (maybeChildSyncPoint && maybeChildSyncPoint.hasCompleteView()) {
      var completeView = maybeChildSyncPoint.getCompleteView();
      return [completeView];
    } else {
      // No complete view here, flatten any deeper listens into an array
      var views = [];
      if (maybeChildSyncPoint) {
        views = maybeChildSyncPoint.getQueryViews();
      }
      goog.object.forEach(childMap, function(childViews) {
        views = views.concat(childViews);
      });
      return views;
    }
  });
};

/**
 * @param {!Array.<!fb.api.Query>} queries
 * @private
 */
fb.core.SyncTree.prototype.removeTags_ = function(queries) {
  for (var j = 0; j < queries.length; ++j) {
    var removedQuery = queries[j];
    if (!removedQuery.getQueryParams().loadsAllData()) {
      // We should have a tag for this
      var removedQueryKey = this.makeQueryKey_(removedQuery);
      var removedQueryTag = this.queryToTagMap_[removedQueryKey];
      delete this.queryToTagMap_[removedQueryKey];
      delete this.tagToQueryMap_['_' + removedQueryTag];
    }
  }
};


/**
 * Normalizes a query to a query we send the server for listening
 * @param {!fb.api.Query} query
 * @return {!fb.api.Query} The normalized query
 * @private
 */
fb.core.SyncTree.prototype.queryForListening_ = function(query) {
  if (query.getQueryParams().loadsAllData() && !query.getQueryParams().isDefault()) {
    // We treat queries that load all data as default queries
    // Cast is necessary because ref() technically returns Firebase which is actually fb.api.Firebase which inherits
    // from fb.api.Query
    return /** @type {!fb.api.Query} */(query.getRef());
  } else {
    return query;
  }
};


/**
 * For a given new listen, manage the de-duplication of outstanding subscriptions.
 *
 * @param {!fb.api.Query} query
 * @param {!fb.core.view.View} view
 * @return {!Array.<!fb.core.view.Event>} This method can return events to support synchronous data sources
 * @private
 */
fb.core.SyncTree.prototype.setupListener_ = function(query, view) {
  var path = query.path;
  var tag = this.tagForQuery_(query);
  var listener = this.createListenerForView_(view);

  var events = this.listenProvider_.startListening(this.queryForListening_(query), tag, listener.hashFn,
      listener.onComplete);

  var subtree = this.syncPointTree_.subtree(path);
  // The root of this subtree has our query. We're here because we definitely need to send a listen for that, but we
  // may need to shadow other listens as well.
  if (tag) {
    fb.core.util.assert(!subtree.value.hasCompleteView(), "If we're adding a query, it shouldn't be shadowed");
  } else {
    // Shadow everything at or below this location, this is a default listener.
    var queriesToStop = subtree.fold(function(relativePath, maybeChildSyncPoint, childMap) {
      if (!relativePath.isEmpty() && maybeChildSyncPoint && maybeChildSyncPoint.hasCompleteView()) {
        return [maybeChildSyncPoint.getCompleteView().getQuery()];
      } else {
        // No default listener here, flatten any deeper queries into an array
        var queries = [];
        if (maybeChildSyncPoint) {
          queries = queries.concat(
              goog.array.map(maybeChildSyncPoint.getQueryViews(), function(view) {
                return view.getQuery();
              })
          );
        }
        goog.object.forEach(childMap, function(childQueries) {
          queries = queries.concat(childQueries);
        });
        return queries;
      }
    });
    for (var i = 0; i < queriesToStop.length; ++i) {
      var queryToStop = queriesToStop[i];
      this.listenProvider_.stopListening(this.queryForListening_(queryToStop), this.tagForQuery_(queryToStop));
    }
  }
  return events;
};

/**
 *
 * @param {!fb.core.view.View} view
 * @return {{hashFn: function(), onComplete: function(!string, *)}}
 * @private
 */
fb.core.SyncTree.prototype.createListenerForView_ = function(view) {
  var self = this;
  var query = view.getQuery();
  var tag = this.tagForQuery_(query);

  return {
    hashFn: function() {
      var cache = view.getServerCache() || fb.core.snap.EMPTY_NODE;
      return cache.hash();
    },
    onComplete: function(status, data) {
      if (status === 'ok') {
        if (tag) {
          return self.applyTaggedListenComplete(query.path, tag);
        } else {
          return self.applyListenComplete(query.path);
        }
      } else {
        // If a listen failed, kill all of the listeners here, not just the one that triggered the error.
        // Note that this may need to be scoped to just this listener if we change permissions on filtered children
        var error = fb.core.util.errorForServerCode(status, query);
        return self.removeEventRegistration(query, /*eventRegistration*/null, error);
      }
    }
  };
};

/**
 * Given a query, computes a "queryKey" suitable for use in our queryToTagMap_.
 * @private
 * @param {!fb.api.Query} query
 * @return {string}
 */
fb.core.SyncTree.prototype.makeQueryKey_ = function(query) {
  return query.path.toString() + '$' + query.queryIdentifier();
};

/**
 * Given a queryKey (created by makeQueryKey), parse it back into a path and queryId.
 * @private
 * @param {!string} queryKey
 * @return {{queryId: !string, path: !fb.core.util.Path}}
 */
fb.core.SyncTree.prototype.parseQueryKey_ = function(queryKey) {
  var splitIndex = queryKey.indexOf('$');
  fb.core.util.assert(splitIndex !== -1 && splitIndex < queryKey.length - 1, 'Bad queryKey.');
  return {
    queryId: queryKey.substr(splitIndex + 1),
    path: new fb.core.util.Path(queryKey.substr(0, splitIndex))
  };
};

/**
 * Return the query associated with the given tag, if we have one
 * @param {!number} tag
 * @return {?string}
 * @private
 */
fb.core.SyncTree.prototype.queryKeyForTag_ = function(tag) {
  return goog.object.get(this.tagToQueryMap_, '_' + tag);
};

/**
 * Return the tag associated with the given query.
 * @param {!fb.api.Query} query
 * @return {?number}
 * @private
 */
fb.core.SyncTree.prototype.tagForQuery_ = function(query) {
  var queryKey = this.makeQueryKey_(query);
  return fb.util.obj.get(this.queryToTagMap_, queryKey);
};

/**
 * Static tracker for next query tag.
 * @type {number}
 * @private
 */
fb.core.SyncTree.nextQueryTag_ = 1;

/**
 * Static accessor for query tags.
 * @return {number}
 * @private
 */
fb.core.SyncTree.getNextQueryTag_ = function() {
  return fb.core.SyncTree.nextQueryTag_++;
};

/**
 * A helper method to apply tagged operations
 *
 * @param {!fb.core.util.Path} queryPath
 * @param {!string} queryId
 * @param {!fb.core.Operation} operation
 * @return {!Array.<!fb.core.view.Event>}
 * @private
 */
fb.core.SyncTree.prototype.applyTaggedOperation_ = function(queryPath, queryId, operation) {
    var syncPoint = this.syncPointTree_.get(queryPath);
    fb.core.util.assert(syncPoint, "Missing sync point for query tag that we're tracking");
    var writesCache = this.pendingWriteTree_.childWrites(queryPath);
    return syncPoint.applyOperation(operation, writesCache, /*serverCache=*/null);
}

/**
 * A helper method that visits all descendant and ancestor SyncPoints, applying the operation.
 *
 * NOTES:
 * - Descendant SyncPoints will be visited first (since we raise events depth-first).

 * - We call applyOperation() on each SyncPoint passing three things:
 *   1. A version of the Operation that has been made relative to the SyncPoint location.
 *   2. A WriteTreeRef of any writes we have cached at the SyncPoint location.
 *   3. A snapshot Node with cached server data, if we have it.

 * - We concatenate all of the events returned by each SyncPoint and return the result.
 *
 * @param {!fb.core.Operation} operation
 * @return {!Array.<!fb.core.view.Event>}
 * @private
 */
fb.core.SyncTree.prototype.applyOperationToSyncPoints_ = function(operation) {
  return this.applyOperationHelper_(operation, this.syncPointTree_, /*serverCache=*/ null,
      this.pendingWriteTree_.childWrites(fb.core.util.Path.Empty));

};

/**
 * Recursive helper for applyOperationToSyncPoints_
 *
 * @private
 * @param {!fb.core.Operation} operation
 * @param {fb.core.util.ImmutableTree.<!fb.core.SyncPoint>} syncPointTree
 * @param {?fb.core.snap.Node} serverCache
 * @param {!fb.core.WriteTreeRef} writesCache
 * @return {!Array.<!fb.core.view.Event>}
 */
fb.core.SyncTree.prototype.applyOperationHelper_ = function(operation, syncPointTree, serverCache, writesCache) {

  if (operation.path.isEmpty()) {
    return this.applyOperationDescendantsHelper_(operation, syncPointTree, serverCache, writesCache);
  } else {
    var syncPoint = syncPointTree.get(fb.core.util.Path.Empty);

    // If we don't have cached server data, see if we can get it from this SyncPoint.
    if (serverCache == null && syncPoint != null) {
      serverCache = syncPoint.getCompleteServerCache(fb.core.util.Path.Empty);
    }

    var events = [];
    var childName = operation.path.getFront();
    var childOperation = operation.operationForChild(childName);
    var childTree = syncPointTree.children.get(childName);
    if (childTree && childOperation) {
      var childServerCache = serverCache ? serverCache.getImmediateChild(childName) : null;
      var childWritesCache = writesCache.child(childName);
      events = events.concat(
          this.applyOperationHelper_(childOperation, childTree, childServerCache, childWritesCache));
    }

    if (syncPoint) {
      events = events.concat(syncPoint.applyOperation(operation, writesCache, serverCache));
    }

    return events;
  }
};

/**
 * Recursive helper for applyOperationToSyncPoints_
 *
 * @private
 * @param {!fb.core.Operation} operation
 * @param {fb.core.util.ImmutableTree.<!fb.core.SyncPoint>} syncPointTree
 * @param {?fb.core.snap.Node} serverCache
 * @param {!fb.core.WriteTreeRef} writesCache
 * @return {!Array.<!fb.core.view.Event>}
 */
fb.core.SyncTree.prototype.applyOperationDescendantsHelper_ = function(operation, syncPointTree,
                                                                       serverCache, writesCache) {
  var syncPoint = syncPointTree.get(fb.core.util.Path.Empty);

  // If we don't have cached server data, see if we can get it from this SyncPoint.
  if (serverCache == null && syncPoint != null) {
    serverCache = syncPoint.getCompleteServerCache(fb.core.util.Path.Empty);
  }

  var events = [];
  var self = this;
  syncPointTree.children.inorderTraversal(function(childName, childTree) {
    var childServerCache = serverCache ? serverCache.getImmediateChild(childName) : null;
    var childWritesCache = writesCache.child(childName);
    var childOperation = operation.operationForChild(childName);
    if (childOperation) {
      events = events.concat(
          self.applyOperationDescendantsHelper_(childOperation, childTree, childServerCache, childWritesCache));
    }
  });

  if (syncPoint) {
    events = events.concat(syncPoint.applyOperation(operation, writesCache, serverCache));
  }

  return events;
};
