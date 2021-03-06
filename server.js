'use strict';
var http = require('http');
var fs = require('fs');
var child_process = require('child_process');
var PORT = Number(process.argv[2]) || 8080;

var BASE_URL = './';
//Regular expressions for battery and networks paths. We are building a RESTful API, so URL's path will matter
//For battery info, the acceptable patterns are '/battery' and all the ones starting with '/battery/'
var RE_BATTERY = /\/battery\/?/;
//For wifi info, the acceptable patterns are '/network', '/networks', '/wifi', and all the ones starting with either '/network/', '/networks/' or '/wifi/'
var RE_NETWORKS = /\/(?:(?:networks?)|(?:wifi))\/?/;

var NET_CELL_PREFIX = 'Cell';
var NET_ADDRESS_PREFIX = 'Address';
var NET_QUALITY_PREFIX = 'Quality';
var NET_SIGNAL_PREFIX = 'Signal level';
var NET_EXTRA_PREFIX = 'Extra';

var CONFIG = getConfigForCurrentOS();

var WINDOWS_CHARGING_STATE_MAP = {
  1: 'discharging',
  2: 'charging'
};

var BATTERY_ERROR_MESSAGE = '500 - Unable to retrieve battery status';
var WIFI_ERROR_MESSAGE = '500 - Unable to retrieve wifi status';

function getConfigForCurrentOS () {
  switch(process.platform) {
    case 'linux':
      return {
      	batteryCommand: 'upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep -E "state|time to empty|to full|percentage"',
        batteryProcessFunction: processBatteryStdoutForLinux,
        wifiCommand: 'iwlist wlan0 scanning | egrep "Cell |Address|Channel|Frequency|Encryption|Quality|Signal level|Last beacon|Mode|Group Cipher|Pairwise Ciphers|Authentication Suites|ESSID"',
        wifiProcessFunction: processWifiStdoutForLinux
      };
    case 'darwin': //MAC
      return {
      	batteryCommand: 'pmset -g batt | egrep "([0-9]+\%).*" -o',
      	batteryProcessFunction: processBatteryStdoutForMac,
        wifiCommand: '',
        wifiProcessFunction: function () {}
      };
    case 'win32':
      return {
      	batteryCommand: 'WMIC Path Win32_Battery',
      	batteryProcessFunction: processBatteryStdoutForWindows,
        wifiCommand: '',
        wifiProcessFunction: function () {}
      };
    default:
      return {
      	batteryCommand: '',
      	batteryProcessFunction: function () {},
        wifiCommand: '',
        wifiProcessFunction: function () {}
      };
  }
}

function processBatteryLineForLinux(battery, line) {
  var key;
  var val;

  line = line.trim();
  if (line.length > 0) {
    line = line.split(':');
    if (line.length === 2) {
      line = line.map(trimParam);
      key = line[0];
      val = line[1];
      battery[key] = val;
    }
  }
  return battery;
}

function processBatteryLineForWindows(battery, key, val) {
  key = key.trim();
  val = val.trim();
  battery[key] = val;

  return battery;
}

function mapBatteryKeysForLinux(battery) {
	var mappedBattery = {};
	mappedBattery.percentage = battery.percentage;
	mappedBattery.state = battery.state;
	mappedBattery.timeToEmpty = battery['time to empty'];
	return mappedBattery;
}

function mapBatteryKeysForMac(battery) {
	var mappedBattery = {};
	mappedBattery.percentage = battery[0];
	mappedBattery.state = battery[1];
	mappedBattery.timeToEmpty = battery[2];
	return mappedBattery;
}

function mapBatteryKeysForWindows(battery) {
  var mappedBattery = {};
  mappedBattery.percentage = battery['EstimatedChargeRemaining'];
  mappedBattery.state = WINDOWS_CHARGING_STATE_MAP[battery['BatteryStatus']];
  mappedBattery.timeToEmpty = battery['TimeOnBattery'];
  return mappedBattery;
}

function processBatteryStdoutForLinux(stdout) {
	var battery = {},
			processLine = processBatteryLineForLinux.bind(null, battery);
  stdout.split('\n').forEach(processLine);
  return mapBatteryKeysForLinux(battery);
}

function processBatteryStdoutForMac(stdout) {
	var battery = stdout.split(';').map(trimParam);
  return mapBatteryKeysForMac(battery);
}

function processBatteryStdoutForWindows(stdout) {
  var lines = stdout.split('\n').map(trimParam),
      battery = {},
      processLine = processBatteryLineForWindows.bind(null, battery),
      headersStr,
      paramsStr,
      headers,
      fieldsPositions,
      lastIndex,
      i,
      n;

  if (lines.length < 2) {
    return {};
  }

  headersStr = lines[0];
  paramsStr = lines[1];
  headers = headersStr
    .split(' ')
    .filter(function(s) {
      return s.length > 0;
    });
  lastIndex = -1;
  fieldsPositions = headers
    .map(function (h) {
      lastIndex = headersStr.indexOf(h, lastIndex + 1);
      return lastIndex;
    });
  fieldsPositions.push(headersStr.length);
  n = fieldsPositions.length;
  for (i = 0; i < n - 1; i++) {
    processLine(headers[i], paramsStr.substr(fieldsPositions[i], fieldsPositions[i+1] - fieldsPositions[i]));
  }

  return mapBatteryKeysForWindows(battery);
}

function stringStartsWith (string, prefix) {
    return string.slice(0, prefix.length) == prefix;
}

/**
  * @method processWifiLineForLinux
  * @description
  * Extracts the parameter(s) in a line of the input file (as generated by iwlist wlan0 scanning)
  * and adds it (them) to the cell's dictionary.
  *
  * @param {String} line The line of text from the input file to be scanned.
  * @param {Object} cell The object gathering current cell's properties.
  *
  * @return {Object} A dictionary with key-value pairs.
  */
function processWifiLineForLinux(cell, line) {
  var key;
  var val;

  line = line.trim();
  if (line.length > 0) {
    switch (true) {

      case stringStartsWith(line, NET_ADDRESS_PREFIX):
      line = line.split(':');
      line.splice(0, 1);
      //INVARIANT: Address in the format Address: DC:0B:1A:47:BA:07
      if (line.length > 0) {
        cell[NET_ADDRESS_PREFIX] = line.join(":");
      }
      break;
    case stringStartsWith(line, NET_QUALITY_PREFIX):
      //INVARIANT: this line must have a similar format: Quality=41/70  Signal level=-69 dBm
      line = line.split(NET_SIGNAL_PREFIX);
      cell[NET_QUALITY_PREFIX] = line[0].split("=")[1].trim();
      if (line.length > 1) {
        cell[NET_SIGNAL_PREFIX] = line[1].split("=")[1].trim();
      }
      break;
    case stringStartsWith(line, NET_EXTRA_PREFIX):
      //INVARIANT: this line must have a similar format: Extra: Last beacon: 1020ms ago
      line = line.split(":");
      //we can ignore the prefix of the string
      if (line.length > 2) {
        cell[line[1].trim()] = line[2].trim();
      }
      break;
    default:
      //INVARIANT: the field must be formatted as "key : value"
      line = line.split(":");
      if (line.length > 1) {
        //Just stores the key-value association, so that coupling with client is reduced to the min:
        //values will be examined only on the client side
        cell[line[0].trim()] = line[1].trim();
      }
    }
  }

  return cell;
}

function mapWifiKeysForLinux(d) {
  return d;
}

function processWifiStdoutForLinux(stdout) {
  var networks = {};
  var net_cell = "";
  var cell = {};

  stdout.split('\n').map(trimParam).forEach(function (line) {
    if (line.length > 0) {
      //check if the line starts a new cell
      if (stringStartsWith(line, NET_CELL_PREFIX)) {
        if (net_cell.length > 0) {
          networks[net_cell] = mapWifiKeysForLinux(cell);
        }
        cell = {};
        line = line.split("-");
        net_cell = line[0].trim();
        line = line[1];
      }
      //Either way, now we are sure we have a non empty line with (at least one) key-value pair
      //       and that cell has been properly initialized
      processWifiLineForLinux(cell, line);
    }

  });
  if (net_cell.length > 0) {
    networks[net_cell] = mapWifiKeysForLinux(cell);
  }
  return networks;
}

function jsonResponseWrapper(response, data) {
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*'
  });
  response.write(data);
  response.end();
}

var onBatteryInfo = jsonResponseWrapper;
var onWifiInfo = jsonResponseWrapper;

function onError(response, msg) {
  response.writeHead(404, {'Content-Type': 'text/plain'});
  response.write(msg);
  response.end();
}

function trimParam(param) {
  return param.trim();
}

function getBatteryStatus(response, onSuccess, onError) {

  child_process.exec(CONFIG.batteryCommand, function execBatteryCommand(err, stdout, stderr) {
    var battery;

    if (err) {
      console.log('child_process failed with error code: ' + err.code);
      onError(response, BATTERY_ERROR_MESSAGE);
    } else {

			try {
	      battery = CONFIG.batteryProcessFunction(stdout);
	      onSuccess(response, JSON.stringify(battery));
	    } catch (e) {
	      console.log(e);
	      onError(response, BATTERY_ERROR_MESSAGE);
	    }
	  }
	});
}

function getWifiStatus(response, onSuccess, onError) {

  child_process.exec(CONFIG.wifiCommand, function execWifiCommand(err, stdout, stderr) {
    var wifi;

    if (err) {
      console.log('child_process failed with error code: ' + err.code);
      onError(response, WIFI_ERROR_MESSAGE);
    } else {

      try {
        wifi = CONFIG.wifiProcessFunction(stdout);
        onSuccess(response, JSON.stringify(wifi));
      } catch (e) {
        console.log(e);
        onError(response, WIFI_ERROR_MESSAGE);
      }
    }
  });
}

var server = http.createServer(function (request, response) {
  var requestUrl = request.url;
  var filePath = BASE_URL + requestUrl;

  if (requestUrl === '/' || requestUrl === '') {
    response.writeHead(301,
      {
        Location: BASE_URL + 'public/demo.html'
      });
    response.end();
  } else if (RE_BATTERY.test(requestUrl)) {
    getBatteryStatus(response, onBatteryInfo, onError);
  } else if (RE_NETWORKS.test(requestUrl)) {
    getWifiStatus(response, onWifiInfo, onError);
  } else {
    fs.exists(filePath, function (exists) {

      if (exists) {
        fs.readFile(filePath, function (error, content) {
          if (error) {
            response.writeHead(500);
            response.end();
          } else {
            response.writeHead(200);  //, { 'Content-Type': 'text/html' }
            response.end(content, 'utf-8');
          }
        });
      } else {
        response.writeHead(404, {'Content-Type': 'text/plain'});
        response.write('404 - Resurce Not found');
        response.end();
      }
    });
  }
}).listen(PORT);
console.log('Server running on port ' + PORT);  //'at http://127.0.0.1:' + port
