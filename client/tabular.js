/* global _, Template, Tabular, Tracker, ReactiveVar, Session, Meteor, tableInit, getPubSelector, Util */

Template.tabular.helpers({
  atts: function () {
    // We remove the "table" and "selector" attributes and assume the rest belong
    // on the <table> element
    return _.omit(this, "table", "selector");
  }
});

var tabularOnRendered = function () {
  var template = this,
      dataTableInstance = null,
      resetTablePaging = false,
      $tableElement = template.$('table');

  template.tabular = {};
  template.tabular.data = [];
  template.tabular.geoSpatialQuery = new ReactiveVar({});
  template.tabular.pubSelector = new ReactiveVar({});
  template.tabular.skip = new ReactiveVar(0);
  template.tabular.limit = new ReactiveVar(10);
  template.tabular.sort = new ReactiveVar(null, Util.objectsAreEqual);
  template.tabular.columns = null;
  template.tabular.fields = null;
  template.tabular.searchFields = null;
  template.tabular.searchCaseInsensitive = true;
  template.tabular.tableName = new ReactiveVar(null);
  template.tabular.options = new ReactiveVar({}, Util.objectsAreEqual);
  template.tabular.docPub = new ReactiveVar(null);
  template.tabular.collection = new ReactiveVar(null);
  template.tabular.ready = new ReactiveVar(false);
  template.tabular.recordsTotal = 0;
  template.tabular.recordsFiltered = 0;
  template.tabular.isLoading = new ReactiveVar(true);


  // These are some DataTables options that we need for everything to work.
  // We add them to the options specified by the user.
  var ajaxOptions = {
    // tell DataTables that we're getting the table data from a server
    serverSide: true,
    // define the function that DataTables will call upon first load and whenever
    // we tell it to reload data, such as when paging, etc.
    ajax: function (data, callback/*, settings*/) {
      // When DataTables requests data, first we set
      // the new skip, limit, order, and pubSelector values
      // that DataTables has requested. These trigger
      // the first subscription, which will then trigger the
      // second subscription.

      template.tabular.sort.get(); // reactive trigger

      template.tabular.isLoading.set(true);
      //console.log('data', template.tabular.data);

      // Update skip
      template.tabular.skip.set(data.start);
      Session.set('Tabular.LastSkip', data.start);

      // Update limit
      var options = template.tabular.options.get();
      var hardLimit = options && options.limit;
      if (data.length === -1) {
        if (hardLimit === undefined) {
          console.warn('When using no paging or an "All" option with tabular, it is best to also add a hard limit in your table options like {limit: 500}');
          template.tabular.limit.set(null);
        } else {
          template.tabular.limit.set(hardLimit);
        }
      } else {
        template.tabular.limit.set(data.length);
      }

      // Update sort
      template.tabular.sort.set(Util.getMongoSort(data.order, template.tabular.columns));
      // Update pubSelector

      var pubSelector = getPubSelector(
        template.tabular.selector,
        (data.search && data.search.value) || null,
        template.tabular.searchFields,
        template.tabular.searchCaseInsensitive,
        data.columns || null
      );

      template.tabular.pubSelector.set(pubSelector);

      // We're ready to subscribe to the data.
      // Matters on the first run only.
      template.tabular.ready.set(true);

      //console.log('ajax');

      callback({
        draw: data.draw,
        recordsTotal: template.tabular.recordsTotal,
        recordsFiltered: template.tabular.recordsFiltered,
        data: template.tabular.data
      });

    }
  };

  // For testing
  //setUpTestingAutoRunLogging(template);

  // Reactively determine table columns, fields, and searchFields.
  // This will rerun whenever the current template data changes.
  var lastTableName;
  template.autorun(function () {
    var data = Template.currentData();

    if (!data) {return;}

    // We get the current TabularTable instance, and cache it on the
    // template instance for access elsewhere
    var tabularTable = template.tabular.tableDef = data.table;

    if (!(tabularTable instanceof Tabular.Table)) {
      throw new Error("You must pass Tabular.Table instance as the table attribute");
    }

    template.tabular.selector = data.selector;

    // The remaining stuff relates to changing the `table`
    // attribute. If we didn't change it, we can stop here,
    // but we need to reload the dataTableInstance if this is not the first
    // run
    if (tabularTable.name === lastTableName) {
      if (dataTableInstance) {
        // passing `true` as the second arg tells it to
        // reset the paging
        dataTableInstance.ajax.reload(null, false);
      }
      return;
    }

    // If we reactively changed the `table` attribute, run
    // onUnload for the previous table
    if (lastTableName !== undefined) {
      var lastTableDef = Tabular.tablesByName[lastTableName];
      if (lastTableDef && typeof lastTableDef.onUnload === 'function') {
        lastTableDef.onUnload();
      }
    }

    // Cache this table name as the last table name for next run
    lastTableName = tabularTable.name;

    // Figure out and update the columns, fields, and searchFields
    tableInit(tabularTable, template);

    // Set/update everything else
    template.tabular.searchCaseInsensitive = (tabularTable.options && tabularTable.options.search && tabularTable.options.search.caseInsensitive) || true;
    template.tabular.options.set(tabularTable.options);
    template.tabular.tableName.set(tabularTable.name);
    template.tabular.docPub.set(tabularTable.pub);
    template.tabular.collection.set(tabularTable.collection);


    // userOptions rerun should do this?
    if (dataTableInstance) {
      // passing `true` as the second arg tells it to
      // reset the paging
      dataTableInstance.ajax.reload(null, true);
    }
  });

  // First Subscription
  // Subscribe to an array of _ids that should be on the
  // current page of the dataTableInstance, plus some aggregate
  // numbers that DataTables needs in order to show the paging.
  // The server will reactively keep this info accurate.
  // It's not necessary to call stop
  // on subscriptions that are within autorun computations.
  template.autorun(function () {
    if (!template.tabular.ready.get()) {
      return;
    }

    var geoQuery = Session.get('geoQuery');

    //console.log('tabular_getInfo autorun');
    Meteor.subscribe(
      "tabular_getInfo",
      template.tabular.tableName.get(),
      template.tabular.pubSelector.get(),
      null, //template.tabular.sort.get(),
      template.tabular.skip.get(),
      template.tabular.limit.get(),
      geoQuery
    );
  });

  // Second Subscription
  // Reactively subscribe to the documents with _ids given to us. Limit the
  // fields to only those we need to display. It's not necessary to call stop
  // on subscriptions that are within autorun computations.
  template.autorun(function () {
    // tableInfo is reactive and causes a rerun whenever the
    // list of docs that should currently be in the dataTableInstance changes.
    // It does not cause reruns based on the documents themselves
    // changing.
    var tableName = template.tabular.tableName.get();
    var tableInfo = Tabular.getRecord(tableName) || {};

    //console.log('tableName and tableInfo autorun', tableName, tableInfo);
    template.tabular.recordsTotal = tableInfo.recordsTotal || 0;
    template.tabular.recordsFiltered = tableInfo.recordsFiltered || 0;

    // In some cases, there is no point in subscribing to nothing
    if (_.isEmpty(tableInfo) ||
        template.tabular.recordsTotal === 0 ||
        template.tabular.recordsFiltered === 0) {
      return;
    }

    template.tabular.tableDef.sub.subscribe(
      template.tabular.docPub.get(),
      tableName,
      tableInfo.ids || [],
      template.tabular.fields
    );
  });

  // Build the dataTableInstance. We rerun this only when the table
  // options specified by the user changes, which should be
  // only when the `table` attribute changes reactively.
  //var optionsAutorunCount = 0
  template.autorun(function (c) {
    var userOptions = template.tabular.options.get();
    var options = _.extend({}, ajaxOptions, userOptions);

    //optionsAutorunCount += 1
    //console.log('autorunCount', optionsAutorunCount)

    // unless the user provides their own displayStart,
    // we use a value from Session. This keeps the
    // same page selected after a hot code push.
    if (c.firstRun && !('displayStart' in options)) {
      options.displayStart = Tracker.nonreactive(function () {
        return Session.get('Tabular.LastSkip');
      });
    }

    if (!('order' in options)) {
      options.order = [];
    }

    // We start with an empty dataTableInstance.
    // Data will be populated by ajax function now.
    //
    // NOTE: We render on a future tick with requestAnimationFrame, because for
    // some reason this autorun runs twice in rapid succession at first if we
    // don't defer to a future tick (I don't yet know why deferring results in
    // a single render - Joe).
    //
    // TODO: Fix the actual problem with the dependencies initially changing
    // twice rapid succession. We should move all table rendering code into a
    // single place instead of across the autoruns in this onRendered handler.
    requestAnimationFrame(function() {
      // After the first time, we need to destroy before rebuilding.
      if (dataTableInstance) {
        dataTableInstance.destroy();
        dataTableInstance = null
        $tableElement.empty();
      }

      dataTableInstance = $tableElement.DataTable(options);
      handleShadowEffect(template)
    })

  });

  template.autorun(function () {
    // Get table name non-reactively
    var tableName = Tracker.nonreactive(function () {
      return template.tabular.tableName.get();
    });
    // Get the collection that we're showing in the table non-reactively
    var collection = Tracker.nonreactive(function () {
      return template.tabular.collection.get();
    });

    // React when the requested list of records changes.
    // This can happen for various reasons.
    // * DataTables reran ajax due to sort changing.
    // * DataTables reran ajax due to page changing.
    // * DataTables reran ajax due to results-per-page changing.
    // * DataTables reran ajax due to search terms changing.
    // * `selector` attribute changed reactively
    // * Docs were added/changed/removed by this user or
    //   another user, causing visible result set to change.
    var tableInfo = Tabular.getRecord(tableName);

    if (!collection || !tableInfo) {
      return;
    }

    // Build options object to pass to `find`.
    // It's important that we use the same options
    // that were used in generating the list of `_id`s
    // on the server.
    var findOptions = {};
    var fields = template.tabular.fields;
    if (fields) {
      // Extend with extraFields from table definition
      if (typeof template.tabular.tableDef.extraFields === 'object') {
        _.extend(fields, template.tabular.tableDef.extraFields);
      }
      findOptions.fields = fields;
    }

    // Sort does not need to be reactive here; using
    // reactive sort would result in extra rerunning.
    var sort = Tracker.nonreactive(function () {
      return template.tabular.sort.get();
    });

    //if (sort) {
    //  findOptions.sort = sort;
    //}

    // Get the updated list of docs we should be showing
    var cursor = collection.find({_id: {$in: tableInfo.ids}}, findOptions);

    //console.log('tableInfo, fields, sort, find autorun', cursor.count());

    // We're subscribing to the docs just in time, so there's
    // a good chance that they aren't all sent to the client yet.
    // We'll stop here if we didn't find all the docs we asked for.
    // This will rerun one or more times as the docs are received
    // from the server, and eventually we'll have them all.
    // Without this check in here, there's a lot of flashing in the
    // table as rows are added.
    if (cursor.count() < tableInfo.ids.length) {
      return;
    }

    // Get data as array for DataTables to consume in the ajax function
    template.tabular.data = cursor.fetch();

    // Custom sort logic: We implement this logic to enable support for custom sort functions.
    //
    // With custom sort functions, sorting is no longer limited to the data fields on a certain
    // collection. We can implement sort logic based on whatever data we need, even data from
    // other collections.
    //
    // To create a custom sort function for a table column, just include a `customSortFunction`
    // option in column definition. A `customSortFunction` defines the sort order. It accepts two
    // arguments (e.g. a and b) and returns a negative number (a is sorted before b),
    // 0 (a is equal to b) or a positive number (a is sorted after b).
    //
    // (Note: By using this custom logic, we no longer make use of the sort operator of MongoDB.
    // This is because we can't combine MongoDB sort with our custom sort).
    if (sort) {
      // Build up the sort chain, which will eventually be passed to the native JavaScript
      // Array.prototype.sort() method. See https://github.com/Teun/thenBy.js for more information.
      var sortChain = firstBy(function() {return 0});

      _.each(sort, function(criterium) {
        var direction = criterium.direction === 'desc' ? -1 : 1;

        // Custom sorting using custom function
        if (criterium.customSortFunction) {
          sortChain = sortChain.thenBy(criterium.customSortFunction, direction);

        // Normal sorting using data field
        } else {
          // (Note: This logic is still a basic implementation. It works for all of our current use
          // cases, but may not do well for new use cases we have in the future. If at some point
          // you see that tabular table sorting is behaving unusually, or if you see the
          // 'This comparison is invalid or not supported' error, then consider updating this logic).
          sortChain = sortChain.thenBy(function(a, b) {
            a = App.getObjectProperty(a, criterium.originalSortDataField);
            b = App.getObjectProperty(b, criterium.originalSortDataField);

            if (!a && b)
              return -1;

            if (a && !b)
              return 1;

            if (!a && !b)
              return 0;

            if (typeof a !== typeof b)
              return a.toString().localeCompare(b.toString());

            if (_.isNumber(a) || _.isDate(a))
              return a - b;

            if (_.isString(a))
              return a.localeCompare(b);

            throw new Meteor.Error('This comparison is invalid or not supported');
          }, direction);
        }
      });

      // Actually perform sorting
      template.tabular.data.sort(sortChain);
    }

    template.tabular.isLoading.set(false);

    // For these types of reactive changes, we don't want to
    // reset the page we're on, so we pass `false` as second arg.
    // The exception is if we changed the results-per-page number,
    // in which cases `resetTablePaging` will be `true` and we will do so.
    if (dataTableInstance) {
      if (resetTablePaging) {
        dataTableInstance.ajax.reload(null, true);
        resetTablePaging = false;
      } else {
        dataTableInstance.ajax.reload(null, false);
      }
    }

  });

  // XXX Not working
  template.autorun(function () {
    var visibility = template.tabular.isLoading.get() ? 'visible' : 'hidden';
    template.$('.dataTables_processing').css('visibility', visibility);
  });

  // force table paging to reset to first page when we change page length
  $tableElement.on('length.dt', function () {
    resetTablePaging = true;
  });
};

Template.tabular.onRendered(tabularOnRendered);

var tabularOnDestroyed = function () {
  // Clear last skip tracking
  Session.set('Tabular.LastSkip', 0);
  // Run a user-provided onUnload function
  if (this.tabular &&
      this.tabular.tableDef &&
      typeof this.tabular.tableDef.onUnload === 'function') {
    this.tabular.tableDef.onUnload();
  }
};

Template.tabular.onDestroyed(tabularOnDestroyed);

//function setUpTestingAutoRunLogging(template) {
//  template.autorun(function () {
//    var val = template.tabular.tableName.get();
//    console.log('tableName changed', val);
//  });
//
//  template.autorun(function () {
//    var val = template.tabular.pubSelector.get();
//    console.log('pubSelector changed', val);
//  });
//
//  template.autorun(function () {
//    var val = template.tabular.sort.get();
//    console.log('sort changed', val);
//  });
//
//  template.autorun(function () {
//    var val = template.tabular.skip.get();
//    console.log('skip changed', val);
//  });
//
//  template.autorun(function () {
//    var val = template.tabular.limit.get();
//    console.log('limit changed', val);
//  });
//}

function handleShadowEffect(template) {
  var tableCol = template.$('.table-col')[0]

  // If the browser has non-overlaid scrollbars (i.e. scrollbars use layout
  // space, unlike on mobile), we adjust so the scroll bar appears outside of
  // the shadow.
  if (tableCol.offsetHeight != tableCol.clientHeight) {
    // If the style wasn't already added.
    if (!document.querySelector('#tabular-scrollbar-detected-style')) {
      var css = document.createTextNode('\
        div.dataTables_wrapper > .table-row > .table-col {\
          padding-bottom: 12px;\
        }\
        div.dataTables_wrapper > .table-row > .shadow {\
          height: calc(100% - 20px);\
        }\
      ')

      var styleEl = document.createElement('style')
      styleEl.id = 'tabular-scrollbar-detected-style'
      styleEl.appendChild(css)
      document.head.appendChild(styleEl)
    }
  }

  var shadow = template.$('.shadow')[0]

  // We poll for maxScrollAmount here for 1.5 seconds. If at any time it is
  // greater than zero (i.e. we can scroll at least 1 pixel) then we set the
  // initial right-side shadow.
  var elapsedTimeSinceLastFrame = 0
  var totalTime = 0
  var lastTimestamp = performance.now()
  var maxScrollAmount = 0
  requestAnimationFrame(function poll(timestamp) {
    maxScrollAmount = tableCol.scrollWidth - tableCol.clientWidth
    elapsedTimeSinceLastFrame = timestamp - lastTimestamp
    totalTime += elapsedTimeSinceLastFrame
    lastTimestamp = timestamp

    // If the table is scrollable (i.e. the table is wider than the viewport it
    // is in),
    if (maxScrollAmount > 0) {
      // show the right shadow
      shadow.classList.add('right')
    }

    // stop polling after 1.5 seconds.
    if (totalTime < 1500) requestAnimationFrame(poll)
  })

  // Show left or right shadow based on scroll position.
  // For some reason, using addEventListener listener works here, but I wasn't
  // able to get this working with jQuery.on().
  template.$('.table-col')[0].addEventListener('scroll', function(event) {

    // request an animation frame, for performance, only if one isn't queued.
    if (!template.rAF) {
      template.rAF = requestAnimationFrame(function() {
        var maxScrollAmount = tableCol.scrollWidth - tableCol.clientWidth
        var scrollAmount = event.target.scrollLeft

        handleScroll(shadow, scrollAmount, maxScrollAmount)
        template.rAF = null
      })
    }

  })
}

function handleScroll(shadow, scrollAmount, maxScrollAmount) {
  // if we're all the way left
  if (scrollAmount == 0) {
    shadow.classList.remove('left', 'both')
    shadow.classList.add('right')
  }
  else if (scrollAmount > 0 && scrollAmount < maxScrollAmount) {
    shadow.classList.remove('left', 'right')
    shadow.classList.add('both')
  }
  else if (scrollAmount == maxScrollAmount) {
    shadow.classList.remove('both', 'right')
    shadow.classList.add('left')
  }
}
