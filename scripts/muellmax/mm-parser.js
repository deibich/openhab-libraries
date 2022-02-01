// Use custom Logger. openhab-js logger is one trace by default. I don't like that.
var logger = Java.type("org.slf4j.LoggerFactory").getLogger('deibich.rules.muellmax-parser');

// Use Jsoup for http requests and processing. TODO: Switch to JS variant if available. I could use HTTP action but I'm not able to parse html.
var Jsoup = Java.type('org.jsoup.Jsoup');

// Use Javas time api. Joda-Js gives me an error on ZoneId.of('Europe/Berlin'). idk why.
var LocalDate = Java.type('java.time.LocalDate')
var ZoneId = Java.type('java.time.ZoneId')
var Month = Java.type('java.time.Month')

// DateTimeType to set the state of items
var DateTimeType = Java.type('org.openhab.core.library.types.DateTimeType')

// ------------ User Settings Start

var groupName = 'Group_Waste'; // Items get created within this group. required, must exist
var wasteProvider = 'dus'; // waste provider shortcut. required, must be valid
var city = ''; // city from list with available cities. see logs, if needed.
var street = ''; // street from list with available street. see logs, if needed.
var number = ''; // number from list with available number. see logs, if needed.
var recreateItemIfNotPresent = false; // Create item again if deleted
var deleteItemsInGroup = false; // cleanup. removes all items withing provided group which are tagged with 'muellmax-parser'
var checkItemsBeforeRequest = true; // Check if state of items in group with tag muellmax-parser are NULL/UNDEF or date is before today and do http-request only if required.

// ------------ User Settings End

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
var wasteURL = 'https://www.muellmax.de/abfallkalender/' + wasteProvider + '/res/' + wasteProvider.charAt(0).toUpperCase() + wasteProvider.slice(1) + 'Start.php';

var groupItem = undefined;
var currentSessionId = undefined;
var previousPageName = undefined;
var currentPageName = undefined;
var wasteTypesDict = {};
var itemNamePrefix = undefined;

function setGroupItemFromGroupName() {
    logger.trace('begin setGroupItemFromGroupName');
    logger.trace('name for groupItem is set to: ' + groupName);
    try {
        logger.trace('before request to itemRegistry');
        groupItem = items.getItem(groupName);
        logger.trace('found an item');
        if (groupItem.type !== 'GroupItem') {
            logger.error('Can\'t find a GroupItem with the provided groupName. Please select a valid Group in the rule template.');
            groupItem = undefined;
        } else {
            logger.debug('Provided name for groupItem: ' + groupName + ' results in a valid group');
        }
    } catch (e) {
        logger.debug(e.toString());
        logger.error('Error while retrieving group item. Please select a valid Group in the rule template.');
    }
    logger.trace('setGroupItemFromGroupName end');
}

function setSessionIdFromDoc(doc) {
    logger.trace('begin setSessionIdFromDoc');
    currentSessionId = undefined;
    let elementWithSessionId = doc.selectFirst('input[name=mm_ses]');
    if (elementWithSessionId === null) {
        logger.error('Could not find sessionId in provided document');
        logger.trace(doc.toString());
        return;
    }
    currentSessionId = elementWithSessionId.attr('value');
    logger.debug('found sessionId: ' + currentSessionId);
    logger.trace('end setSessionIdFromDoc');
}

function getStartPage() {
    logger.trace('begin getStartPage');
    let pageToReturn = undefined;
    try {
        logger.trace('before get request');
        pageToReturn = Jsoup.connect(wasteURL).get();
        logger.trace('after get request');
    } catch (e) {
        logger.error('Error on get request for startPage');
        logger.debug(e.toString());
        pageToReturn = undefined;
    }
    logger.trace('end getStartPage');
    return pageToReturn;
}

function postPage(argumentDict) {
    logger.trace('begin postPage with arguments: ' + JSON.stringify(argumentDict));
    let pageToReturn = undefined;
    try {
        logger.trace('before post request');
        pageToReturn = Jsoup.connect(wasteURL).data(argumentDict).post();
        logger.trace('after post request');
    } catch (e) {
        logger.error('postPage request with error');
        logger.debug(e.toString());
        pageToReturn = undefined;
    }
    logger.trace('end postPage');
    return pageToReturn;
}

function getPageNameFromDoc(doc) {
    logger.trace('begin getPageNameFromDoc');

    let navList = doc.select('#m_box > ul[class$=hidden]');
    if (navList.isEmpty()) {
        logger.error('Cant\'t find navList on page');
        logger.trace('end getPageNameFromDoc');
        return undefined;
    }
    logger.trace('Found navList in document');

    let navElements = navList.select('li > a[href]');
    logger.trace('Found ' + navElements.size() + ' entries in navList');

    let pageId = undefined;

    logger.trace('iteratre over entries from navList');
    navElements.forEach(element => {
        if (pageIdentifier.includes(element.attr('href'))) {
            pageId = element.attr('href');
            logger.trace('Current element has pageId: ' + pageId);
            return;
        }
    });

    if (pageId === undefined) {
        logger.error('Could not identify current page');
        logger.trace('end getPageNameFromDoc');
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

    logger.debug('final pageId is: ' + pageId);

    if (!Object.keys(pageMappings).includes(pageId)) {
        logger.error('Could not identify current page with identifier' + pageId);
        logger.trace('end getPageNameFromDoc');
        return undefined;
    }

    logger.trace('Try to get pageName from pageMappings');
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
        logger.trace('end gotoPage');
        return undefined;
    }
    logger.trace('set previousPageName to: ' + currentPageName);
    previousPageName = currentPageName;

    currentPageName = getPageNameFromDoc(pageToReturn);
    if (currentPageName === undefined || (expectedPageNames.length > 0 && !expectedPageNames.includes(currentPageName))) {
        logger.error('Exit because could not reach one of the following pages: ' + JSON.stringify(expectedPageNames));
        logger.trace('end gotoPage');
        return undefined;
    }

    setSessionIdFromDoc(pageToReturn);
    logger.trace('end gotoPage');
    return pageToReturn;
}

function htmlWasteTypeStringToWasteType(htmlString) {
    logger.trace('htmlWasteTypeStringToWasteType begin');
    let newString = htmlString.replace(/[^\w ]/g, function(char) {
        return charsToReplace[char] || char;
    });
    newString = newString.replace(/[^\w ]/g, ' ');
    newString = newString.replace(/\s+/g, ' ').trim();
    newString = newString.replace(/\s+/g, '_');
    logger.trace('htmlWasteTypeStringToWasteType end');
    return newString;
}

function processCity(cityDoc, pageName) {
    logger.trace('begin processCity with pageName: ' + pageName);

    let availableElements = cityDoc.getElementById('mm_frm_ort_sel');

    if (availableElements == null) {
        logger.error('Could not find options for cities');
        logger.trace('end processCity');
        return undefined;
    }

    availableElements = availableElements.select('option');
    logger.debug('Found ' + availableElements.size() + ' entries');

    let cityNames = {};
    logger.trace('Iterate over entries');
    availableElements.forEach(element => {
        logger.trace('City: ' + element.html() + ' with key: ' + element.attr('value'));
        cityNames[element.attr('value')] = element.html();
    });

    logger.trace('Check if user provided city is in available cities');
    if (!Object.keys(cityNames).includes(city)) {
        logger.debug('Provided city not available.');
        let output = [];
        Object.keys(cityNames).forEach(key => {
            output.push('City: ' + cityNames[key] + ' - Key to enter in rule template: ' + key);
        });
        logger.warn('Please enter a valid city name from the following list:\n' + output.join('\n'));
        logger.trace('end processCity');
        return undefined;
    }
    logger.trace('City is available');
    let retVal = gotoPage({ 'mm_frm_ort_sel': city, 'mm_aus_ort_submit': 'weiter' });
    logger.trace('processCity end');
    return retVal;
}

function processStreet(streetDoc, pageName) {
    logger.trace('begin processStreet with pageName: ' + pageName);

    let retVal = undefined;
    if (pageName === 'street_text') {
        logger.trace('Street page is with text input');
        retVal = gotoPage({ 'mm_frm_str_name': street, 'mm_aus_str_txt_submit': 'suchen' });
        logger.trace('processStreet end after post text input');
        return retVal;
    }

    // Get Street names
    let streetNames = {};
    logger.trace('Search streetNames on page');
    let availableElements = streetDoc.getElementById('mm_frm_str_sel');

    if (availableElements == null) {
        logger.error('Could not find options for streetNames');
        logger.trace('end processStreet');
        return undefined;
    }

    availableElements = availableElements.select('option');
    logger.trace('Found ' + availableElements.size() + ' entries');
    logger.trace('Iterate over entries');
    availableElements.forEach(element => {
        logger.trace('Street: ' + element.html() + ' with key: ' + element.attr('value'));
        streetNames[element.attr('value')] = element.html();
    });

    logger.trace('Check if user provided street is in available cities');
    if (!Object.keys(streetNames).includes(street)) {
        logger.trace('Provided street not available.');
        output = [];
        Object.keys(streetNames).forEach(key => {
            output.push('Street: ' + streetNames[key] + ' - Key to enter in rule template: ' + key);
        });
        logger.warn('Please enter a valid street name from the following list:\n' + output.join('\n'));
        logger.trace('end processStreet');
        return undefined;
    }
    logger.trace('Street is available');
    retVal = gotoPage({ 'mm_frm_str_sel': city, 'mm_aus_str_txt_submit': 'weiter' });
    logger.trace('end processStreet after street submit txt');
    return retVal;
}

function processNumber(numberDoc, pageName) {
    logger.trace('begin processNumber with pageName: ' + pageName);



    logger.trace('Search numbers on page');
    let availableElements = numberDoc.getElementById('mm_frm_hnr_sel');
    if (availableElements === null) {
        logger.error('Could not find options for numbers');
        logger.trace('end processNumber');
        return undefined;
    }

    availableElements = availableElements.select('option');
    let numberNames = {};
    logger.trace('Found ' + availableElements.size() + ' entries');
    logger.trace('Iterate over entries');
    availableElements.forEach(element => {
        logger.trace('Number: ' + element.html() + ' with key: ' + element.attr('value'));
        numberNames[element.attr('value')] = element.html();
    });

    logger.trace('Check if user provided number is in available numbers');
    if (!Object.keys(numberNames).includes(number)) {
        logger.trace('Provided number not available.');
        let output = [];
        Object.keys(numberNames).forEach(key => {
            output.push('Number: ' + numberNames[key] + ' - Key to enter in rule template: ' + key);
        });
        logger.warn('Please enter a valid number from the following list:\n' + output.join('\n'));
        logger.trace('end processNumber');
        return undefined;
    }
    logger.debug('Number is available');
    let retVal = gotoPage({ 'mm_frm_hnr_sel': number, 'mm_aus_hnr_sel_submit': 'weiter' });
    logger.trace('end processNumber');
    return retVal;
}

function extractWasteTypesFromWeekInfo(infoDoc) {
    logger.trace('begin extractWasteTypesFromWeekInfo');

    let docElements = infoDoc.select('div[class=m_art_text]');
    if (docElements == null || docElements.size() < 1) {
        logger.error('Could not find any wasteTypes');
        logger.trace('end extractWasteTypesFromWeekInfo')
        return undefined;
    }
    let wasteTypes = {};
    logger.trace('Found ' + docElements.size() + ' possible wasteTypes');
    docElements.forEach(element => {
        let stringVal = element.html();
        let currWasteType = htmlWasteTypeStringToWasteType(stringVal);
        wasteTypes[currWasteType] = { 'name': stringVal, 'dates': [] };
        logger.trace('Found wasteType: ' + stringVal + 'with key: ' + currWasteType);
    })
    logger.debug('Found ' + Object.keys(wasteTypes).length + ' wasteTypes');
    logger.trace('end extractWasteTypesFromWeekInfo');
    return wasteTypes;
}

function extractDatesFromMonthPage(monthDoc) {
    logger.trace('begin extractDatesFromMonthPage');
    let monthEntriesHtml = monthDoc.select('div[class=m_day]');
    logger.trace('Found ' + monthEntriesHtml.size() + ' entries');
    let oneWasDecember = dateToday.getMonthValue() == 12;

    monthEntriesHtml.forEach((monthEntryHtml, idx) => {
        let monthDateElementsHtml = monthEntryHtml.select('h1, h2, h3, h4, h5, h6, h7');

        if (monthDateElementsHtml.size() < 1) {
            logger.error('Can\'t find montDateElement for monthEntry. Try next one.');
            return;
        }

        logger.trace('Try to extract day and month from html');
        let dayString = '';
        let monthString = '';
        try {
            let monthDayString = monthDateElementsHtml[0].html().split(',')[0].split(' ');
            dayString = monthDayString[0].slice(0, -1);
            monthString = monthDayString[1];
        } catch (e) {
            logger.error('Could not extract day and month. Try next one');
            logger.debug(e.toString());
            return;
        }
        logger.trace('get Java Month then monthValue from extracted month');
        if (!Object.keys(germanMonthToJavaMonth).includes(monthString)) {
            logger.debug('Extracted month is not in mapping-dict: ' + monthString + ' Try next one');
            return;
        }

        if (germanMonthToJavaMonth[monthString].getValue() == 12) {
            logger.trace('Extracted Month is December');
            oneWasDecember = true;
        }

        let currYear = dateToday.getYear();
        if (oneWasDecember && germanMonthToJavaMonth[monthString].getValue() < 6) {
            currYear += 1
        }
        logger.trace('Extracted Year is ' + currYear);

        let dateForEntry = LocalDate.of(currYear, germanMonthToJavaMonth[monthString].getValue(), parseInt(dayString))
        let stringDateForEntry = dateForEntry.toString();

        monthEntryHtml.select('p').forEach(wasteEle => {
            logger.trace('Added date ' + stringDateForEntry + ' for ' + wasteEle);
            wasteTypesDict[htmlWasteTypeStringToWasteType(wasteEle.html())]['dates'].push(stringDateForEntry)
        });
    });

    logger.trace('Sort dates for wasteTypeDict');
    Object.keys(wasteTypesDict).forEach(key => {
        logger.trace('Sort dates for: ' + key);
        wasteTypesDict[key]['dates'] = wasteTypesDict[key]['dates'].sort((a, b) => {
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
    logger.trace('end extractDatesFromMonthPage');
}

function createAndUpdateItems() {
    logger.trace('begin createAndUpdateItems');
    let groupHasMuellmaxItem = false;
    groupHasMuellmaxItem = groupItem.members.some(groupMember => {
        return groupMember.tags.includes('muellmax-parser');
    });

    Object.keys(wasteTypesDict).forEach(key => {
        let wasteItemForName = undefined;
        let wasteItemName = htmlWasteTypeStringToWasteType(itemNamePrefix + ' ' + key);

        try {
            wasteItemForName = items.getItem(wasteItemName);
        } catch (e) {
            logger.trace(e.toString());
            logger.debug('Could not get item with name ' + wasteItemName);
        }

        if (wasteItemForName === undefined) {
            // Could not find item
            if (recreateItemIfNotPresent || !groupHasMuellmaxItem) {
                try {
                    wasteItemForName = items.addItem(wasteItemName, 'DateTime', undefined, [groupName], wasteTypesDict[key]['name'], ['muellmax-parser', 'Point', 'Timestamp'], undefined, undefined);
                } catch (e) {
                    logger.trace(e.toString());
                    logger.error('Could not create item with name ' + wasteItemName);
                }
            } else {
                logger.debug('Do not create item. Because settings prevent creation.');
            }
        }

        if (wasteItemForName !== undefined) {
            let currWasteItemState = wasteItemForName.state;
            logger.trace('process item: ' + wasteItemForName.name);
            if (wasteTypesDict[key]['dates'].length > 0) {
                logger.trace('Dates for item available');
                let dateForPossibleNewState = LocalDate.parse(wasteTypesDict[key]['dates'][0]);
                let possibleNewState = new DateTimeType(dateForPossibleNewState.atStartOfDay(ZoneId.of('Europe/Berlin')))
                if (currWasteItemState === 'NULL') {
                    logger.trace('State is currently not set.');
                    wasteItemForName.sendCommand(possibleNewState);
                } else {
                    logger.trace('State was set. Check if update is required');
                    let currentItemZDT = wasteItemForName.rawState.getZonedDateTime();
                    let currentItemLD = currentItemZDT.toLocalDate();
                    if (dateToday.isAfter(currentItemLD) && (dateForPossibleNewState.isAfter(dateToday) || dateForPossibleNewState.isEqual(dateToday))) {
                        logger.trace('Update state with ' + possibleNewState.toString());
                        try {
                            wasteItemForName.sendCommand(possibleNewState);
                        } catch (e) {
                            logger.debug('Error on update for item ' + wasteItemForName + ' with state ' + possibleNewState.toString());
                            logger.trace(e.toString());
                        }
                    } else {
                        logger.trace('New state not required');
                    }
                }
            }
        }
    });
    logger.trace('end createAndUpdateItems');
}

function itemsNeedUpdate() {
    logger.trace('begin itemsNeedUpdate');
    let updateRequired = false;
    // Items need to be updated when one of the following is true
    //   - Group has no members with tag muellmax-tag
    //   - State of at least one Member of Group with tag muellmax is:
    //      - UNDEF
    //      - isBefore(today)
    //   - recreateItemIfNotPresent is true
    if (recreateItemIfNotPresent) {
        logger.debug('Items need update because recreateItemIfNotPresent is true');
        logger.trace('end recreateItemIfNotPresent');
        return true;
    }

    let groupMembers = groupItem.members.filter(groupMember => {
        return groupMember.tags.includes('muellmax-parser');
    });

    if (groupMembers.length < 1) {
        logger.debug('Items need update because there are no groupmembers with tag muellmax-parser');
        logger.trace('end recreateItemIfNotPresent');
        return true;
    }

    updateRequired = groupMembers.some(groupMember => {
        return groupMember.state === 'NULL' || groupMember.rawState.getZonedDateTime().toLocalDate().isBefore(dateToday);
    })
    logger.debug('Update is required: ' + updateRequired);
    logger.trace('end itemsNeedUpdate');
    return updateRequired;
}

function process() {
    logger.trace('begin process');
    setGroupItemFromGroupName();

    if (groupItem === undefined) {
        logger.error('Exit because groupName does not return a valid GroupItem.');
        return;
    }

    itemNamePrefix = htmlWasteTypeStringToWasteType([wasteProvider, city, street, number].join(' '))

    if (deleteItemsInGroup) {
        logger.trace('Delete Items is set');
        groupItem.members.forEach(possibleItemToRemove => {
            if (possibleItemToRemove.tags.includes('muellmax-parser')) {
                logger.warn('Try to remove: ' + possibleItemToRemove.name);
                try {
                    items.removeItem(possibleItemToRemove.name);
                } catch (e) {
                    // Error is always thrown idk why. Don't care.
                }
            }
        });
        logger.trace('Exit after delete.');
        return;
    }

    if (checkItemsBeforeRequest && !itemsNeedUpdate()) {
        logger.trace('Items don\'t need an update.');
        return;
    }

    // Get Start
    let doc = getStartPage();
    if (doc === undefined) {
        logger.error('Exit because startPage is not available.');
        return;
    }
    currentPageName = getPageNameFromDoc(doc);
    previousPageName = currentPageName;
    if (previousPageName == undefined) {
        logger.error('Exit because can\'t set previousPageName for startPage.');
        return;
    }
    setSessionIdFromDoc(doc);

    // Goto first page with input
    doc = gotoPage({ 'mm_aus_ort': '' });
    if (doc === undefined) {
        logger.error('Exit because processStart returned undefined');
        return;
    }

    // Process Pages until we reach page 'format'
    logger.trace('Process Pages before while');

    while (allowedPageTransitions[previousPageName].indexOf(currentPageName) > -1 && currentPageName !== 'format') {
        logger.trace('Inside while with previousPageName: ' + previousPageName + ', currentPageName: ' + currentPageName + ', sessionId: ' + currentSessionId);

        switch (currentPageName) {
            case 'city_select':
                doc = processCity(doc, currentPageName);
                break;
            case 'street_text':
            case 'street_select':
                doc = processStreet(doc, currentPageName);
                break;
            case 'number_select':
                doc = processNumber(doc, currentPageName);
                break;
        }

        if (doc === undefined) {
            logger.error('Exit from inside while because doc is undefined inside while')
            return;
        }
    }

    logger.trace('After while');
    // Now we have format page
    if (currentPageName !== 'format') {
        logger.error('Exit because could not reach page "format"');
        return;
    }

    logger.trace('Found page "format". Continue with processing');
    // Go to week
    // Go to week_info
    // Get all waste types
    // Go back to week
    // process x weeks

    // Goto week
    doc = gotoPage({ 'mm_woc': '' }, 'week');
    if (doc === undefined) {
        return;
    }

    // Goto week_info
    doc = gotoPage({ 'mm_inf_woche': '' }, 'week_info');
    if (doc === undefined) {
        return;
    }

    // Get all waste types
    wasteTypesDict = extractWasteTypesFromWeekInfo(doc);
    if (wasteTypesDict === undefined) {
        errorMsg('Exit. No wasteTypes found');
        return;
    }

    // Go back to week
    doc = gotoPage({ 'mm_woc': '' }, 'week');
    if (doc === undefined) {
        return;
    }
    // go back to format
    doc = gotoPage({ 'mm_aus_fmt': '' }, 'format');
    if (doc === undefined) {
        return;
    }
    // go to month 
    doc = gotoPage({ 'mm_mon': '' }, 'month');
    if (doc === undefined) {
        return;
    }

    // get all wasteTypes from month page with dates
    extractDatesFromMonthPage(doc);
    createAndUpdateItems();

    logger.trace('process end');
}

logger.trace('begin rule');
process();
logger.trace('end rule');