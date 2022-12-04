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

```Settings -> Automation -> Language & Technologies -> JSScripting```

_Jsoup_ is used to perform and parse web requests and is shipped with other bindings or addons.
The easiest way to get Jsoup is to install Jinja transformation. 
Go to:

```Settings -> Other Add-Ons ->  Transformation Add-ons  -> Jinja Transformation```

## Howto
First install the dependencies from "Requirements" above.

As rule:
Create a new rule with script (ECMAScript 262 Edition 11) in mainUI and paste the whole content of the script.

Get the shortcut for your region from the table above and paste it into userSettings.location.wasteCollectionShortcut.
You need a group item which will hold the items for all schedules. Paste the name of the group item into userSettings.groupName.

Save and run the rule/script. 
Open your logfile and look for outputs from "deibich.scripts.mm-waste-schedules".
You should see several options for userSettings.location.city, userSettings.location.street or userSettings.location.number.
Search your city, street or number in the logs, paste it into the correct variable and rerun the script until the options for your location are set.
Not all options are required.

The script creates several items as member of the provided group item "groupName".
Do not change the options under userSettings.location after the items are created.

Check the created items and delete the items you don't need.
Set userSettings.items.recreateItemIfNotPresent to false to prevent recreation of the deleted items.

Now you can add a trigger:
e.g. System Event - Startup complete and a Time Event shortly after midnight.

*/

var userSettings = {
  groupName: '',                       // Items get created within this group. required
  location: {
    wasteCollectionShortcut: '',                 // waste provider shortcut. required. Available options see table.
    city: '',                          // city from list with available cities. see logs, if needed.
    street: '',                        // street from list with available street. see logs, if needed.
    number: ''                         // number from list with available number. see logs, if needed.
  },
  items: {
    recreateItemIfNotPresent: true,    // Create item again if deleted
    checkItemsBeforeRequest: true,     // Check if state of items in group with tag mm-waste-schedule are NULL/UNDEF or date is before today and do http-request only if required.
    deleteItemsInGroup: false,         // cleanup. removes all items withing provided group which are tagged with tag in mmItemTag (default is mm-waste-schedule)
    stateDescriptionPatternOnCreation: // Add a pattern to the stateDescription of the created items. This only happens once per new item. Let extactly one of the following lines uncommented
      ''
      // '%1$td.%1$tm'       // 13.01
      // '%1$ta, %1$td.%1$tm'       // Thu, 13.01
      // '%1$td.%1$tm.%1$ty' // 13.05.22
      // '%1$td.%1$tm.%1$tY' // 13.05.2022
  }
};


// Use custom Logger. openhab-js logger is one trace by default. I don't like that.
var logger = Java.type('org.slf4j.LoggerFactory').getLogger('deibich.scripts.mm-waste-schedules');

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
var itemTagsForCreation = [mmItemTag, 'Timestamp'];

var wasteURL = '';
var groupItem = undefined;
var currentSessionId = undefined;
var previousPageName = undefined;
var currentPageName = undefined;
var wasteScheduleDict = {};
var itemNamePrefix = undefined;

function setGroupItemFromGroupName() {
  logger.trace('name for groupItem is set to: ' + userSettings.groupName);
  try {
    groupItem = items.getItem(userSettings.groupName);
    if (groupItem.type !== 'GroupItem') {
      logger.error('Can\'t find a GroupItem with the provided group name. Please set a valid group name at the top of the script.');
      groupItem = undefined;
    } else {
      logger.trace('Provided group name: ' + userSettings.groupName + ' results in a valid group');
    }
  } catch (e) {
    logger.debug(e.toString());
    logger.error('Error while retrieving group item. Please select a valid Group in the rule template.');
  }
}

function setSessionIdFromDoc(doc) {
  currentSessionId = undefined;
  let elementWithSessionId = doc.selectFirst('input[name=mm_ses]');
  if (elementWithSessionId === null) {
    logger.error('Could not find sessionId in provided document');
    logger.trace(doc.toString());
    return;
  }
  currentSessionId = elementWithSessionId.attr('value');
  // logger.trace('found sessionId: ' + currentSessionId);
}

function getStartPage() {
  let pageToReturn = undefined;
  try {
    pageToReturn = Jsoup.connect(wasteURL).get();
  } catch (e) {
    logger.error('Error on get request for startPage');
    logger.debug(e.toString());
    pageToReturn = undefined;
  }
  return pageToReturn;
}

function postPage(argumentDict) {
  logger.trace('begin postPage with arguments: ' + JSON.stringify(argumentDict));
  let pageToReturn = undefined;
  try {
    pageToReturn = Jsoup.connect(wasteURL).data(argumentDict).post();
  } catch (e) {
    logger.error('postPage request with error');
    logger.debug(e.toString());
    pageToReturn = undefined;
  }
  return pageToReturn;
}

function getPageNameFromDoc(doc) {

  let navList = doc.select('#m_box > ul[class$=hidden]');
  if (navList.isEmpty()) {
    logger.error('Cant\'t find navList on page');
    return undefined;
  }

  let navElements = navList.select('li > a[href]');
  logger.trace('Found ' + navElements.size() + ' entries in navList');

  let pageId = undefined;

  navElements.forEach(element => {
    if (pageIdentifier.includes(element.attr('href'))) {
      pageId = element.attr('href');
      logger.trace('Current element has pageId: ' + pageId);
      return;
    }
  });

  if (pageId === undefined) {
    logger.error('Could not identify current page');
    return undefined;
  }

  logger.trace('Found pageId ' + pageId);
  if (pageId == '#m_strassenauswahl') {
    logger.trace('pageId is special');
    if (doc.getElementById('mm_frm_str_name') !== null) {
      pageId = pageId + '#mm_frm_str_name';
    } else {
      pageId = pageId + '#mm_frm_str_sel';
    }
    logger.trace('Changed pageId to ' + pageId);
  }

  logger.trace('final pageId is: ' + pageId);

  if (!Object.keys(pageMappings).includes(pageId)) {
    logger.error('Could not identify current page with identifier' + pageId);
    logger.trace('end getPageNameFromDoc');
    return undefined;
  }

  let pageName = pageMappings[pageId];

  logger.trace('end getPageNameFromDoc with pageName: ' + pageName);
  return pageName
}

function gotoPage(argumentDict, ...expectedPageNames) {
  logger.trace('begin gotoPage with expectedPageNames: ' + expectedPageNames);
  argumentDict['mm_ses'] = currentSessionId;

  let pageToReturn = postPage(argumentDict);
  if (pageToReturn === undefined) {
    logger.error('Exit because request returned undefined document');
    return undefined;
  }
  logger.trace('set previousPageName to: ' + currentPageName);
  previousPageName = currentPageName;

  currentPageName = getPageNameFromDoc(pageToReturn);
  if (currentPageName === undefined || (expectedPageNames.length > 0 && !expectedPageNames.includes(currentPageName))) {
    logger.error('Exit because could not reach one of the following pages: ' + JSON.stringify(expectedPageNames));
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
  logger.trace('begin processPageSelect with pageName: ' + pageName);

  logger.trace('Search ' + userSettingName + ' on page');
  let availableElements = doc.getElementById(selectionIdentifier);
  if (availableElements === null) {
    logger.error('Could not find options for ' + userSettingName);
    return undefined;
  }

  availableElements = availableElements.select('option');
  let keyNames = {};

  logger.debug('Found ' + availableElements.size() + ' entries for ' + userSettingName);
  availableElements.forEach(element => {
    keyNames[element.attr('value')] = element.html();
  });
  logger.debug(JSON.stringify(keyNames));

  logger.trace('Check if ' + userSettingName + ' in userSettings.location is in available ' + userSettingName);
  if (!Object.keys(keyNames).includes(userSettingForLocation)) {
    logger.trace('Provided ' + userSettingName + ' not available.');
    let output = [];
    Object.keys(keyNames).forEach(key => {
      if (key.includes(userSettingForLocation)) {
        output.push(userSettingName + ': ' + keyNames[key] + ' - Set userSettings.location.' + userSettingName + ' to: \'' + key + '\'');
      }
    });
    logger.error('Please enter a valid ' + userSettingName + ' from the following list:\n' + output.join('\n'));
    return undefined;
  }

  logger.debug(userSettingName + ' is available');
  let requestDict = {};
  requestDict[selectionIdentifier] = userSettingForLocation;
  requestDict[submitIdentifier] = 'weiter';
  let retVal = gotoPage(requestDict);
  return retVal;
}

function extractWasteTypesFromWeekInfo(infoDoc) {

  let docElements = infoDoc.select('div[class=m_art_text]');
  if (docElements == null || docElements.size() < 1) {
    logger.error('Could not find any wasteTypes');
    return undefined;
  }
  let wasteTypes = {};
  logger.trace('Found ' + docElements.size() + ' possible wasteTypes');
  docElements.forEach(element => {
    let stringVal = element.html();
    let currWasteType = htmlWasteTypeStringToWasteType(stringVal);
    wasteTypes[currWasteType] = { 'name': stringVal, 'dates': [] };
    // logger.trace('Found wasteType: ' + stringVal + 'with key: ' + currWasteType);
  })
  logger.debug('Found ' + Object.keys(wasteTypes).length + ' wasteTypes');
  logger.debug(JSON.stringify(wasteTypes));
  return wasteTypes;
}

function extractDatesFromMonthPage(monthDoc) {
  let monthEntriesHtml = monthDoc.select('div[class=m_day]');
  logger.trace('Found ' + monthEntriesHtml.size() + ' entries');
  let oneWasDecember = dateToday.getMonthValue() == 12;

  monthEntriesHtml.forEach((monthEntryHtml, idx) => {
    let monthDateElementsHtml = monthEntryHtml.select('h1, h2, h3, h4, h5, h6, h7');

    if (monthDateElementsHtml.size() < 1) {
      logger.error('Can\'t find montDateElement for monthEntry. Try next one.');
      return;
    }

    let dayString = '';
    let monthString = '';
    try {
      let monthDayString = monthDateElementsHtml[0].html().split(',')[0].split(' ');
      dayString = monthDayString[0].slice(0, -1);
      monthString = monthDayString[1];
    } catch (e) {
      logger.warn('Could not extract day and month. Try next one');
      logger.trace(e.toString());
      return;
    }

    if (!Object.keys(germanMonthToJavaMonth).includes(monthString)) {
      logger.trace('Extracted month is not in mapping-dict: ' + monthString + ' Try next one');
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

  logger.trace('Sort dates for wasteTypeDict');
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
  logger.debug(JSON.stringify(wasteScheduleDict));
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
      logger.debug(e.toString());
    }

    if (wasteItemForName === undefined) {
      // Could not find item
      if (userSettings.items.recreateItemIfNotPresent || !groupHasMmItem) {

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
          logger.debug('Item ' + wasteItemName + ' created');
        } catch (e) {
          logger.trace(e.toString());
          logger.error('Could not create item with name ' + wasteItemName);
        }
      } else {
        logger.debug('Do not create item. userSettings prevent creation.');
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
          if(dateForPossibleNewState.isAfter(dateToday) || dateForPossibleNewState.isEqual(dateToday)) {
            break;
          }
        }

        if (currWasteItemState === 'NULL') {
          wasteItemForName.sendCommand(possibleNewState);
        } else {
          let currentItemZDT = wasteItemForName.rawState.getZonedDateTime();
          let currentItemLD = currentItemZDT.toLocalDate();
          if (dateToday.isAfter(currentItemLD)) {
            try {
              wasteItemForName.sendCommand(possibleNewState);
            } catch (e) {
              logger.debug('Error on update for item ' + wasteItemForName + ' with state ' + possibleNewState.toString());
              logger.trace(e.toString());
            }
          } else {
            logger.trace('No new state for ' + wasteItemForName.name + ' required');
          }
        }
      } else {
        logger.debug('No schedules for ' + wasteItemForName.name + ' available.')
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
  //   - recreateItemIfNotPresent is true
  if (userSettings.items.recreateItemIfNotPresent) {
    logger.debug('Items need update because userSettings.items.recreateItemIfNotPresent is true');
    return true;
  }

  let groupMembers = groupItem.members.filter(groupMember => {
    return groupMember.tags.includes(mmItemTag);
  });

  if (groupMembers.length < 1) {
    logger.debug('Items need update because there are no groupmembers with tag ' + mmItemTag);
    return true;
  }
  
  updateRequired = groupMembers.some(groupMember => {
    return groupMember.state === 'NULL' || groupMember.rawState.getZonedDateTime().toLocalDate().isBefore(dateToday);
  })
  logger.debug('Update is required: ' + updateRequired);
  return updateRequired;
}

function buildWasteUrl(wasteCollectionShortcut) {
  return 'https://www.muellmax.de/abfallkalender/' + wasteCollectionShortcut + '/res/' + wasteCollectionShortcut.charAt(0).toUpperCase() + wasteCollectionShortcut.slice(1) + 'Start.php';
}

function process() {
  logger.debug('Start mm-waste-schedules with settings: ' + JSON.stringify(userSettings));

  if (userSettings.location.wasteCollectionShortcut === undefined || userSettings.location.wasteCollectionShortcut.length < 3) {
    logger.error('Need userSettings.location.wasteCollectionShortcut to proceed. Please set it at the top of the script.');
    return;
  }

  wasteURL = buildWasteUrl(userSettings.location.wasteCollectionShortcut);
  setGroupItemFromGroupName();

  if (groupItem === undefined) {
    logger.error('Exit. userSettings.groupName does not return a valid GroupItem.');
    return;
  }

  itemNamePrefix = htmlWasteTypeStringToWasteType([userSettings.location.wasteCollectionShortcut, userSettings.location.city, userSettings.location.street, userSettings.location.number].join(' '))

  if (userSettings.items.deleteItemsInGroup) {
    logger.warn('Delete Items is set');
    groupItem.members.forEach(possibleItemToRemove => {
      if (possibleItemToRemove.tags.includes(mmItemTag)) {
        logger.warn('Remove: ' + possibleItemToRemove.name);
        try {
          items.removeItem(possibleItemToRemove.name);
        } catch (e) {
          logger.warn(e.toString());
        }
      }
    });
    logger.warn('Exit after delete.');
    return;
  }

  if (userSettings.items.checkItemsBeforeRequest && !itemsNeedUpdate()) {
    logger.trace('Items don\'t need an update.');
    return;
  }

  // Get Start
  let doc = getStartPage();
  if (doc === undefined) {
    logger.error('Exit. startPage is not available.');
    return;
  }

  currentPageName = getPageNameFromDoc(doc);
  previousPageName = currentPageName;
  if (previousPageName == undefined) {
    logger.error('Exit. Can\'t set previousPageName for startPage.');
    return;
  }
  setSessionIdFromDoc(doc);

  // Goto first page with input
  doc = gotoPage({ 'mm_aus_ort': '' });
  if (doc === undefined) {
    logger.error('Exit. processStart returned undefined.');
    return;
  }

  // Process Pages until we reach page 'format'
  logger.trace('Process Pages before while');

  while (allowedPageTransitions[previousPageName].indexOf(currentPageName) > -1 && currentPageName !== 'format') {
    logger.trace('Inside while with previousPageName: ' + previousPageName + ', currentPageName: ' + currentPageName + ', sessionId: ' + currentSessionId);

    switch (currentPageName) {
      case 'city_select':
        // doc = processCity(doc, currentPageName);
        doc = processPageSelect(doc, currentPageName, 'city', userSettings.location.city, 'mm_frm_ort_sel', 'mm_aus_ort_submit');
        break;
      case 'street_text':
        logger.trace('Street page is with text input');
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
      logger.debug('Exit. doc is undefined inside while.inside while loop');
      return;
    }
  }

  logger.trace('After while');
  // Now we have format page
  if (currentPageName !== 'format') {
    logger.error('Exit. Could not reach page "format".');
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
    logger.error('Exit. Could not reach page "week".');
    return;
  }

  // Goto week_info
  doc = gotoPage({ 'mm_inf_woche': '' }, 'week_info');
  if (doc === undefined) {
    logger.error('Exit. Could not reach page "week_info".');
    return;
  }

  // Get all waste types
  wasteScheduleDict = extractWasteTypesFromWeekInfo(doc);
  if (wasteScheduleDict === undefined) {
    errorMsg('Exit. No wasteTypes found.');
    return;
  }

  // go to month 
  doc = gotoPage({ 'mm_mon': '' }, 'month');
  if (doc === undefined) {
    logger.error('Exit. Could not reach page "month".')
    return;
  }
  // get all wasteTypes from month page with dates
  extractDatesFromMonthPage(doc);
  createAndUpdateItems();

}

logger.trace('begin mm-waste-schedules');
userSettings.location = { ...userSettings.location, ...ctx['location'] };
userSettings.groupName = userSettings.groupName || ctx['groupName'];
userSettings.items = { ...userSettings.items, ...ctx['items'] };

process();
logger.trace('end mm-waste-schedules');
