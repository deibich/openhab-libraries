/*
MM-Waste-Schedules provides schedules for local waste collection services in germany who uses Müllmax for their appointment management.

| Region                        | waste collection company       | wasteCollectionShortcut |
| :---------------------------- | :----------------------------- | :---------------------- |
| Bochum                        | USB Bochum                     | usb                     |
| Darmstadt                     | EAD Darmstadt                  | ead                     |
| Düsseldorf                    | Awista                         | dus                     |
| Frankfurt am Main             | FES Frankfurt                  | fes                     |
| Landkreis Gießen              | LKGI Abfallwirtschaft          | lkg                     |
| Haltern am See                | HAL Abfallwirtschaft           | hal                     |
| Hamm                          | ASH Hamm                       | ash                     |
| Hanau                         | HIS Hanau                      | his                     |
| Kaiserslautern                | Stadtbildpflege Kaiserslautern | ask                     |
| Kreisstadt Friedberg (Hessen) | Kreisstadt Friedberg (Hessen)  | efb                     |
| Maintal                       | Stadt Maintal                  | mai                     |
| Mainz                         | EB Mainz                       | ebm                     |
| Münster                       | AWM Münster                    | awm                     |
| Rhein-Sieg-Kreis              | RSAG                           | rsa                     |
| Saar                          | EVS Saar                       | evs                     |


## Requirements
This script needs _JSScripting_ to perform item creation and modification.
To install JSScripting go to:

```Add-on Store -> Automation -> Language & Technologies -> JavaScript Scripting```

_Jsoup_ is used to perform and parse web requests and is shipped with other bindings or add-ons.
OH < 4.2: Install Jinja transformation. 
OH 4.2 and up: Jinja no longer ships with Jsoup. One of the following bindings is required: ahawaste, smgw, enphase, verisure, ipobserver, generacmobilelink or kostalinverter.

## Howto
First install the dependencies from "Requirements" above.

As rule:
Create a new rule with script (ECMAScript 262 Edition 11) in MainUI and paste the whole script.

Get the shortcut for your region from the table above and paste it into userSettings.location.wasteCollectionShortcut.
You need a group item which will hold the items for all schedules. Paste the name of the group item into userSettings.groupName.

Save and run the rule/script. 
Open your log file or log viewer and look for outputs from "org.openhab.deibich.scripts.mmWasteSchedules".
You should see several options for userSettings.location.city, userSettings.location.street, or userSettings.location.number.
Search your city, street or number in the logs, paste it into the correct variable and rerun the script until the options for your location are set.
Not all options are required.

The script creates several items as members of the provided group item "groupName".
Do not change the options under userSettings.location after the items are created.

Check the created items and delete any items you don't need.
Set userSettings.items.recreateItemIfNotPresent to false to prevent recreation of the deleted items.

Now you can add triggers to check for new schedules:
e.g. System Event - Startup complete and a Time Event shortly after midnight.

*/

var userSettings = {
  groupName: '',                       // Items get created within this group. required
  location: {
    wasteCollectionShortcut: '',       // waste provider shortcut. required. Available options see table.
    city: '',                          // city from list with available cities. see logs, if needed.
    street: '',                        // street from list with available street. see logs, if needed.
    number: ''                         // number from list with available number. see logs, if needed.
  },
  items: {
    recreateItemIfNotPresent: false,    // Create item again if deleted
    checkItemsBeforeRequest: true,     // Check if state of items in group with tag mm-waste-schedule are NULL/UNDEF or date is before today and do http-request only if required.
    deleteItemsInGroup: false,         // cleanup. removes all items within provided group which are tagged with tag in mmItemTag (default is mm-waste-schedule)
    stateDescriptionPatternOnCreation: // Add a pattern to the stateDescription of the created items. This only happens once per new item. Let exactly one of the following lines uncommented
      ''
    // '%1$td.%1$tm'       // 13.01
    // '%1$ta, %1$td.%1$tm'       // Thu, 13.01
    // '%1$td.%1$tm.%1$ty' // 13.05.22
    // '%1$td.%1$tm.%1$tY' // 13.05.2022
  }
};

console.loggerName = 'org.openhab.deibich.scripts.mmWasteSchedules';

// Use Jsoup for http requests and processing. TODO: Switch to JS variant if available. I could use HTTP action but I'm not able to parse html.
var Jsoup = Java.type('org.jsoup.Jsoup');

// Use Javas time api. Joda-Js gives me an error on ZoneId.of('Europe/Berlin'). idk why.
var LocalDate = Java.type('java.time.LocalDate')
var ZoneId = Java.type('java.time.ZoneId')
var Month = Java.type('java.time.Month')

// DateTimeType to set the state of items
var DateTimeType = Java.type('org.openhab.core.library.types.DateTimeType')

// const
var pageIdentifier = [
  '#m_termine',
  '#m_ortsauswahl',
  '#m_strassenauswahl',
  '#m_hausnummernauswahl',
  '#m_ausgabe',
  '#m_woche',
  '#m_info',
  '#m_monat'
];

// const
var pageMappings = {
  '#m_termine': 'start',
  '#m_ortsauswahl': 'city_select',
  '#m_strassenauswahl#mm_frm_str_name': 'street_text',
  '#m_strassenauswahl#mm_frm_str_sel': 'street_select',
  '#m_hausnummernauswahl': 'number_select',
  '#m_ausgabe': 'format',
  '#m_woche': 'week',
  '#m_info': 'week_info',
  '#m_monat': 'month'
};

// const
var allowedPageTransitions = {
  'start': ['city_select', 'street_text', 'street_select', 'number_select', 'format'],
  'city_select': ['street_text', 'street_select', 'number_select', 'format'],
  'street_text': ['street_select', 'number_select', 'format'],
  'street_select': ['number_select', 'format'],
  'number_select': ['format'],
  'format': ['week', 'month'],
  'week': ['week', 'week_info'],
  'week_info': ['week'],
  'month': ['month', 'format']
};

// const
var charsToReplace = {
  'ä': 'ae',
  'ö': 'oe',
  'ü': 'ue',
  'Ä': 'Ae',
  'Ö': 'Oe',
  'Ü': 'Ue',
  'ß': 'ss',
  '(': ' ',
  ')': ' ',
  '-': ' ',
  '.': ' '
};

// const
var germanMonthToJavaMonth = {
  'Januar': Month.JANUARY,
  'Februar': Month.FEBRUARY,
  'März': Month.MARCH,
  'April': Month.APRIL,
  'Mai': Month.MAY,
  'Juni': Month.JUNE,
  'Juli': Month.JULY,
  'August': Month.AUGUST,
  'September': Month.SEPTEMBER,
  'Oktober': Month.OCTOBER,
  'November': Month.NOVEMBER,
  'Dezember': Month.DECEMBER
};

// const
var zoneIdString = 'Europe/Berlin';

// const
var dateToday = LocalDate.now(ZoneId.of(zoneIdString));

// const
var mmItemTag = 'mm-waste-schedule';

// const
var itemTagsForCreation = [mmItemTag];

var wasteURL = '';
var groupItem = undefined;
var currentSessionId = undefined;
var previousPageName = undefined;
var currentPageName = undefined;
var wasteScheduleDict = {};
var itemNamePrefix = undefined;

function setGroupItemFromGroupName() {
  console.trace('name for groupItem is set to: ', userSettings.groupName);
  try {
    groupItem = items.getItem(userSettings.groupName);
    if (groupItem.type !== 'GroupItem' && groupItem.type !== 'Group') {
      console.error('Can\'t find a GroupItem with the provided group name. Please set a valid group name at the top of the script.');
      groupItem = undefined;
    } else {
      console.trace('Provided group name: ', userSettings.groupName, ' results in a valid group');
    }
  } catch (e) {
    console.debug(e.toString());
    console.error('Error while retrieving group item. Please select a valid Group in the rule template.');
  }
}

function setSessionIdFromDoc(doc) {
  currentSessionId = undefined;
  let elementWithSessionId = doc.selectFirst('input[name=mm_ses]');
  if (elementWithSessionId === null) {
    console.error('Could not find sessionId in provided document');
    console.trace(doc.toString());
    return;
  }
  currentSessionId = elementWithSessionId.attr('value');
  console.debug('found sessionId: ', currentSessionId);
}

function getStartPage() {
  let pageToReturn = undefined;
  try {
    pageToReturn = Jsoup.connect(wasteURL).get();
  } catch (e) {
    console.error('Error on get request for startPage');
    console.debug(e.toString());
    pageToReturn = undefined;
  }
  return pageToReturn;
}

function postPage(argumentDict) {
  console.trace('begin postPage with arguments: ', JSON.stringify(argumentDict));
  let pageToReturn = undefined;
  try {
    pageToReturn = Jsoup.connect(wasteURL).data(argumentDict).post();
  } catch (e) {
    console.error('postPage request with error');
    console.debug(e.toString());
    pageToReturn = undefined;
  }
  return pageToReturn;
}

function getPageNameFromDoc(doc) {

  let navList = doc.select('#m_box > ul[class$=hidden]');
  if (navList.isEmpty()) {
    console.error('Cant\'t find navList on page');
    return undefined;
  }

  let navElements = navList.select('li > a[href]');
  console.trace('Found ', navElements.size(), ' entries in navList');

  let pageId = undefined;

  navElements.forEach(element => {
    if (pageIdentifier.includes(element.attr('href'))) {
      pageId = element.attr('href');
      console.trace('Current element has pageId: ', pageId);
      return;
    }
  });

  if (pageId === undefined) {
    console.error('Could not identify current page');
    return undefined;
  }

  console.trace('Found pageId ' + pageId);
  if (pageId == '#m_strassenauswahl') {
    console.trace('pageId is special');
    if (doc.getElementById('mm_frm_str_name') !== null) {
      pageId = pageId + '#mm_frm_str_name';
    } else {
      pageId = pageId + '#mm_frm_str_sel';
    }
    console.trace('Changed pageId to ' + pageId);
  }

  console.trace('final pageId is: ' + pageId);

  if (!Object.keys(pageMappings).includes(pageId)) {
    console.error('Could not identify current page with identifier', pageId);
    console.trace('end getPageNameFromDoc');
    return undefined;
  }

  let pageName = pageMappings[pageId];

  console.trace('end getPageNameFromDoc with pageName: ', pageName);
  return pageName
}

function gotoPage(argumentDict, ...expectedPageNames) {
  console.trace('begin gotoPage with expectedPageNames: ', expectedPageNames);
  argumentDict['mm_ses'] = currentSessionId;

  let pageToReturn = postPage(argumentDict);
  if (pageToReturn === undefined) {
    console.error('Exit because request returned undefined document');
    return undefined;
  }
  console.trace('set previousPageName to: ', currentPageName);
  previousPageName = currentPageName;

  currentPageName = getPageNameFromDoc(pageToReturn);
  if (currentPageName === undefined || (expectedPageNames.length > 0 && !expectedPageNames.includes(currentPageName))) {
    console.error('Exit because could not reach one of the following pages: ', JSON.stringify(expectedPageNames));
    return undefined;
  }

  setSessionIdFromDoc(pageToReturn);
  return pageToReturn;
}

function htmlWasteTypeStringToWasteType(htmlString) {
  let newString = htmlString.replace(/[^\w ]/g, function (char) {
    return charsToReplace[char] || char;
  });
  newString = newString.replace(/[^\w ]/g, ' ');
  newString = newString.replace(/\s+/g, ' ').trim();
  newString = newString.replace(/\s+/g, '_');
  return items.safeItemName(newString);
}

function processPageSelect(doc, pageName, userSettingName, userSettingForLocation, selectionIdentifier, submitIdentifier) {
  console.trace('begin processPageSelect with pageName: ', pageName);

  console.trace('Search ' + userSettingName + ' on page');
  let availableElements = doc.getElementById(selectionIdentifier);
  if (availableElements === null) {
    console.error('Could not find options for ', userSettingName);
    return undefined;
  }

  availableElements = availableElements.select('option');
  let keyNames = {};

  console.debug('Found ', availableElements.size(), ' entries for ', userSettingName);
  availableElements.forEach(element => {
    keyNames[element.attr('value')] = element.html();
  });
  console.debug(JSON.stringify(keyNames));

  console.trace('Check if ', userSettingName, ' in userSettings.location is in available ', userSettingName);
  if (!Object.keys(keyNames).includes(userSettingForLocation)) {
    console.trace('Provided ', userSettingName, ' not available.');
    console.error('Please enter a valid ', userSettingName, ' from the following list:');
    Object.keys(keyNames).forEach(key => {
      if (key.includes(userSettingForLocation)) {
        console.error(userSettingName, ': ', keyNames[key], ' - Set userSettings.location.', userSettingName, ' to: \'', key, '\'');
      }
    });

    return undefined;
  }

  console.debug(userSettingName, ' is available');
  let requestDict = {};
  requestDict[selectionIdentifier] = userSettingForLocation;
  requestDict[submitIdentifier] = 'weiter';
  let retVal = gotoPage(requestDict);
  return retVal;
}

function extractWasteTypesFromWeekInfo(infoDoc) {

  let docElements = infoDoc.select('div[class=m_art_text]');
  if (docElements == null || docElements.size() < 1) {
    console.error('Could not find any waste types');
    return undefined;
  }
  let wasteTypes = {};
  console.trace('Found ', docElements.size(), ' possible waste types');
  docElements.forEach(element => {
    let stringVal = element.html();
    let currWasteType = htmlWasteTypeStringToWasteType(stringVal);
    wasteTypes[currWasteType] = { 'name': stringVal, 'dates': [] };
  })
  console.debug('Found ', Object.keys(wasteTypes).length, ' waste types.');
  console.debug(JSON.stringify(wasteTypes));
  return wasteTypes;
}

function extractDatesFromMonthPage(monthDoc) {
  let monthEntriesHtml = monthDoc.select('div[class=m_day]');
  console.trace('Found ', monthEntriesHtml.size(), ' entries');
  let oneWasDecember = dateToday.getMonthValue() == 12;

  monthEntriesHtml.forEach((monthEntryHtml, idx) => {
    let monthDateElementsHtml = monthEntryHtml.select('h1, h2, h3, h4, h5, h6, h7');

    if (monthDateElementsHtml.size() < 1) {
      console.error('Can\'t find monthDateElement for monthEntry. Try the next one.');
      return;
    }

    let dayString = '';
    let monthString = '';
    try {
      let monthDayString = monthDateElementsHtml[0].html().split(',')[0].split(' ');
      dayString = monthDayString[0].slice(0, -1);
      monthString = monthDayString[1];
    } catch (e) {
      console.warn('Could not extract day and month. Try the next one');
      console.trace(e.toString());
      return;
    }

    if (!Object.keys(germanMonthToJavaMonth).includes(monthString)) {
      console.trace('Extracted month is not in mapping-dict: ', monthString, ' Try the next one');
      return;
    }

    if (germanMonthToJavaMonth[monthString].getValue() == 12) {
      oneWasDecember = true;
    }

    let currYear = dateToday.getYear();
    if (oneWasDecember && germanMonthToJavaMonth[monthString].getValue() < 6) {
      currYear += 1
    }

    let dateForEntry = LocalDate.of(currYear, germanMonthToJavaMonth[monthString].getValue(), parseInt(dayString))
    let stringDateForEntry = dateForEntry.toString();

    monthEntryHtml.select('p').forEach(wasteEle => {
      wasteScheduleDict[htmlWasteTypeStringToWasteType(wasteEle.html())]['dates'].push(stringDateForEntry)
    });
  });

  console.trace('Sort dates for wasteTypeDict');
  Object.keys(wasteScheduleDict).forEach(key => {
    wasteScheduleDict[key]['dates'] = wasteScheduleDict[key]['dates'].sort((a, b) => {
      let dateA = LocalDate.parse(a);
      let dateB = LocalDate.parse(b);
      if (dateA.isBefore(dateB)) {
        return -1;
      }
      if (dateA.isAfter(dateB)) {
        return 1;
      }
      return 0;
    });
  });
  console.debug(JSON.stringify(wasteScheduleDict));
}

function createAndUpdateItems() {
  let groupHasMmItem = false;
  groupHasMmItem = groupItem.members.some(groupMember => {
    return groupMember.tags.includes(mmItemTag);
  });

  Object.keys(wasteScheduleDict).forEach(key => {
    let wasteItemForName = undefined;
    let wasteItemName = htmlWasteTypeStringToWasteType(itemNamePrefix + ' ' + key);

    try {
      wasteItemForName = items.getItem(wasteItemName);
    } catch (e) {
      console.debug(e.toString());
    }

    if (wasteItemForName === undefined) {
      // Could not find item
      if (userSettings.items.recreateItemIfNotPresent && !groupHasMmItem) {

        itemMetaData = {
          stateDescription: {
            config: {
              pattern: userSettings.items.stateDescriptionPatternOnCreation
            }
          }
        };

        try {
          wasteItemForName = items.addItem({
            type: 'DateTime',
            name: wasteItemName,
            label: wasteScheduleDict[key]['name'],
            category: undefined,
            groups: [userSettings.groupName],
            tags: itemTagsForCreation,
            channels: undefined,
            metadata: itemMetaData
          });
          console.debug('Item ', wasteItemName, ' created');
        } catch (e) {
          console.trace(e.toString());
          console.error('Could not create item with name ' + wasteItemName);
        }
      } else {
        console.warn('Do not create item ', wasteItemName, '. userSettings prevent item creation.');
      }
    }

    if (wasteItemForName !== undefined) {
      let currWasteItemState = wasteItemForName.state;
      if (wasteScheduleDict[key]['dates'].length > 0) {

        let dateForPossibleNewState = undefined;

        let possibleNewState = undefined;

        for (let idx = 0; idx < wasteScheduleDict[key]['dates'].length; idx++) {
          dateForPossibleNewState = LocalDate.parse(wasteScheduleDict[key]['dates'][idx]);
          possibleNewState = new DateTimeType(dateForPossibleNewState.atStartOfDay(ZoneId.of('Europe/Berlin')));
          if (dateForPossibleNewState.isAfter(dateToday) || dateForPossibleNewState.isEqual(dateToday)) {
            break;
          }
        }

        if (currWasteItemState === null) {
          wasteItemForName.sendCommand(possibleNewState);
        } else {
          let currentItemZDT = wasteItemForName.rawState.getZonedDateTime(ZoneId.systemDefault());
          let currentItemLD = currentItemZDT.toLocalDate();
          if (dateToday.isAfter(currentItemLD)) {
            try {
              wasteItemForName.sendCommand(possibleNewState);
            } catch (e) {
              console.debug('Error on update for item ', wasteItemForName, ' with state ', possibleNewState.toString());
              console.trace(e.toString());
            }
          } else {
            console.trace('No new state for ', wasteItemForName.name, ' required');
          }
        }
      } else {
        console.debug('No schedules available for ', wasteItemForName.name)
      }
    }
  });
}

function itemsNeedUpdate() {
  let updateRequired = false;
  // Items need to be updated when one of the following is true
  //   - Group has no members with tag mmItemTag
  //   - State of at least one Member of Group with tag mmItemTag is:
  //      - UNDEF
  //      - isBefore(today)

  let groupMembers = groupItem.members.filter(groupMember => {
    return groupMember.tags.includes(mmItemTag);
  });

  if (groupMembers.length < 1) {
    console.debug('Items need update because there are no group members with tag ', mmItemTag);
    return true;
  }

  updateRequired = groupMembers.some(groupMember => {groupMembers
    console.debug(groupMember.state);
    return groupMember.state === null || groupMember.rawState.getZonedDateTime(ZoneId.systemDefault()).toLocalDate().isBefore(dateToday);
  })
  console.debug('Update is required: ', updateRequired);
  return updateRequired;
}

function buildWasteUrl(wasteCollectionShortcut) {
  return 'https://www.muellmax.de/abfallkalender/' + wasteCollectionShortcut + '/res/' + wasteCollectionShortcut.charAt(0).toUpperCase() + wasteCollectionShortcut.slice(1) + 'Start.php';
}

function process() {
  console.debug('Start mm-waste-schedules with settings: ', JSON.stringify(userSettings));

  if (userSettings.location.wasteCollectionShortcut === undefined || userSettings.location.wasteCollectionShortcut.length < 3) {
    console.error('Need userSettings.location.wasteCollectionShortcut to proceed. Please set it at the top of the script.');
    return;
  }

  wasteURL = buildWasteUrl(userSettings.location.wasteCollectionShortcut);
  setGroupItemFromGroupName();

  if (groupItem === undefined) {
    console.error('Exit. userSettings.groupName does not return a valid GroupItem.');
    return;
  }

  itemNamePrefix = htmlWasteTypeStringToWasteType([userSettings.location.wasteCollectionShortcut, userSettings.location.city, userSettings.location.street, userSettings.location.number].join(' '))

  if (userSettings.items.deleteItemsInGroup) {
    console.warn('Delete Items is set');
    groupItem.members.forEach(possibleItemToRemove => {
      if (possibleItemToRemove.tags.includes(mmItemTag)) {
        console.warn('Remove: ', possibleItemToRemove.name);
        try {
          items.removeItem(possibleItemToRemove.name);
        } catch (e) {
          console.warn(e.toString());
        }
      }
    });
    console.warn('Exit after delete.');
    return;
  }

  if (userSettings.items.checkItemsBeforeRequest && !itemsNeedUpdate()) {
    console.trace('Items don\'t need an update.');
    return;
  }

  // Get Start
  let doc = getStartPage();
  if (doc === undefined) {
    console.error('Exit. startPage is not available.');
    return;
  }

  currentPageName = getPageNameFromDoc(doc);
  previousPageName = currentPageName;
  if (previousPageName == undefined) {
    console.error('Exit. Can\'t set previousPageName for startPage.');
    return;
  }
  setSessionIdFromDoc(doc);

  // Goto first page with input
  doc = gotoPage({ 'mm_aus_ort': '' });
  if (doc === undefined) {
    console.error('Exit. processStart returned undefined document.');
    return;
  }

  // Process Pages until we reach page 'format'
  console.trace('Process Pages before while');

  while (allowedPageTransitions[previousPageName].indexOf(currentPageName) > -1 && currentPageName !== 'format') {
    console.trace('Inside while with previousPageName: ', previousPageName, ', currentPageName: ', currentPageName, ', sessionId: ', currentSessionId);

    switch (currentPageName) {
      case 'city_select':
        // doc = processCity(doc, currentPageName);
        doc = processPageSelect(doc, currentPageName, 'city', userSettings.location.city, 'mm_frm_ort_sel', 'mm_aus_ort_submit');
        break;
      case 'street_text':
        console.trace('Street page is with text input');
        doc = gotoPage({ 'mm_frm_str_name': userSettings.location.street, 'mm_aus_str_txt_submit': 'suchen' });
        break;
      case 'street_select':
        // doc = processStreet(doc, currentPageName); 
        doc = processPageSelect(doc, currentPageName, 'street', userSettings.location.street, 'mm_frm_str_sel', 'mm_aus_str_txt_submit');
        break;
      case 'number_select':
        // doc = processNumber(doc, currentPageName);
        doc = processPageSelect(doc, currentPageName, 'number', userSettings.location.number, 'mm_frm_hnr_sel', 'mm_aus_hnr_sel_submit');
        break;
    }

    if (doc === undefined) {
      console.debug('Exit. doc is undefined inside while.');
      return;
    }
  }

  console.trace('After while');
  // Now we have format page
  if (currentPageName !== 'format') {
    console.error('Exit. Could not reach page "format".');
    return;
  }

  // Go to week
  // Go to week_info
  // Get all waste types
  // Go to month
  // Get new entries

  // Goto week
  doc = gotoPage({ 'mm_woc': '' }, 'week');
  if (doc === undefined) {
    console.error('Exit. Could not reach page "week".');
    return;
  }

  // Goto week_info
  doc = gotoPage({ 'mm_inf_woche': '' }, 'week_info');
  if (doc === undefined) {
    console.error('Exit. Could not reach page "week_info".');
    return;
  }

  // Get all waste types
  wasteScheduleDict = extractWasteTypesFromWeekInfo(doc);
  if (wasteScheduleDict === undefined) {
    console.error('Exit. No wasteTypes found.');
    return;
  }

  // go to month 
  doc = gotoPage({ 'mm_mon': '' }, 'month');
  if (doc === undefined) {
    console.error('Exit. Could not reach page "month".')
    return;
  }
  // get all wasteTypes from month page with dates
  extractDatesFromMonthPage(doc);
  createAndUpdateItems();

}

console.trace('begin mm-waste-schedules');
userSettings.location = { ...userSettings.location, ...ctx['location'] };
userSettings.groupName = userSettings.groupName || ctx['groupName'];
userSettings.items = { ...userSettings.items, ...ctx['items'] };

process();
console.trace('end mm-waste-schedules');
