require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const { ExifImage } = require('exif');


cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

const app = express();
app.use(bodyParser.json());

app.use(cors());


const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

app.post('/upload', upload.single('filepond'), async (req, res) => {

  // Extract GPS coordinates
  const exifData = await processImage(req.file.path);
  console.log("Extracted EXIF Data: ", exifData);

  let leftOverlayCondition = determineLeftOverlayCondition(exifData, {}, 'EXIF');
  console.log("left label: ", leftOverlayCondition);

  try {
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "weweb"
    });
    console.log("coordinates: ", exifData.coordinates);
    let address = "";
    let dateTime = "";
    let lat = "";
    let long = "";
    let watermarkedImageUrl = "";


    if (exifData.coordinates){
      const watermarkString = createWatermarkString(exifData.address, exifData.dateTime);
      watermarkedImageUrl = getCloudinaryUrlWithWatermark(result.secure_url, leftOverlayCondition, watermarkString);
  
      console.log("exif: ", watermarkedImageUrl);

    
      address = exifData.address;
      lat = exifData.coordinates.latitude;
      long = exifData.coordinates.longitude;
    }

    if (exifData.dateTime){
      dateTime = exifData.dateTime
    }
    


    res.json({ urlWithOverlay: watermarkedImageUrl, urlNoOverlay: result.secure_url, address: address, dateTime: dateTime, lat :  lat, long : long, leftLabel : leftOverlayCondition});
  } catch (error) {
    console.error('Cloudinary upload failed:', error);
    res.status(500).send('Upload to Cloudinary failed');
  }
});

app.post('/device-location', async (req, res) => {
  // Extract device location from request body
  console.log("body", req.body);
  const { latitude, longitude, timestamp, file, exifAddress, exifdateTime } = req.body;

  let deviceGeoData = { hasGeo: !!latitude, hasTime: !!timestamp }; // Determine if device geo data is present
  let exifGEOData =  { hasGeo: !!exifAddress, hasTime: !!exifdateTime };

  console.log("exif address: ", exifAddress);
  console.log("exif time: ", exifdateTime);

  let leftOverlayCondition = determineLeftOverlayCondition(exifGEOData, deviceGeoData, 'DEVICE');

  let finalAddress, finalTime;
  try {
    const address = await reverseGeocode(latitude, longitude);
    console.log(address);

    if (exifAddress) {
      finalAddress = exifAddress;
    } else if (deviceGeoData.hasGeo) {
      finalAddress = await reverseGeocode(latitude, longitude);
    }

    finalTime = exifdateTime || timestamp;

    const watermarkString = createWatermarkString(finalAddress, finalTime);
    const watermarkedImageUrl = getCloudinaryUrlWithWatermark(file, leftOverlayCondition, watermarkString);

    console.log('watermarkImage', watermarkedImageUrl);

    res.json({ urlOverlay : watermarkedImageUrl, leftLabel :  leftOverlayCondition, address : address});
  } catch (error) {
    console.error('Error processing device location:', error);
    res.status(500).send('Error processing device location');
  }
});



function getExifData(imagePath) {
  return new Promise((resolve, reject) => {
    try {
      new ExifImage({ image: imagePath }, function (error, exifData) {
        if (error) {
          console.log('EXIF Read Error: ' + error.message);
          resolve({ coordinates: null, dateTime: null }); // Resolve with null values
        } else {
          const gpsData = exifData.gps;
          let coordinates = null;
          if (gpsData && gpsData.GPSLatitude && gpsData.GPSLongitude) {
            const latitude = convertGPSDataToDecimal(gpsData.GPSLatitude, gpsData.GPSLatitudeRef);
            const longitude = convertGPSDataToDecimal(gpsData.GPSLongitude, gpsData.GPSLongitudeRef);
            coordinates = { latitude, longitude };
          }

          // Extracting date and time
          let dateTime = null;
          if (exifData.exif && exifData.exif.DateTimeOriginal) {
            dateTime = formatExifDate(exifData.exif.DateTimeOriginal);
          }

          resolve({ coordinates, dateTime });
        }
      });
    } catch (error) {
      console.log('EXIF Processing Error: ' + error.message);
      resolve({ coordinates: null, dateTime: null });
    }
  });
}

function formatExifDate(exifDate) {
  if (!exifDate) {
    return null;
  }

  // EXIF date is in format 'YYYY:MM:DD HH:MM:SS'
  const parts = exifDate.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!parts) {
    return null;
  }

  // Convert it to a JavaScript Date object
  const date = new Date(parts[1], parts[2] - 1, parts[3], parts[4], parts[5], parts[6]);

  // Format to 'MM/DD/YY HH:MM AM/PM'
  const options = { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true };
  return date.toLocaleString('en-US', options);
}


function convertGPSDataToDecimal(gpsData, reference) {
  const degrees = gpsData[0];
  const minutes = gpsData[1];
  const seconds = gpsData[2];
  // Convert to decimal form
  const decimal = degrees + (minutes / 60) + (seconds / 3600);
  // Account for directions, West and South are negative decimals
  return reference === 'S' || reference === 'W' ? decimal * -1 : decimal;
}

async function processImage(imagePath) {
  try {
    const { coordinates, dateTime } = await getExifData(imagePath);
    let address = null;

    if (coordinates) {
      address = await reverseGeocode(coordinates.latitude, coordinates.longitude);
    } else {
      console.log('No coordinates found or error in extraction');
    }

    // console.log('Date and Time:', dateTime);

    return { coordinates, address, dateTime };
  } catch (error) {
    console.error('Error in processImage:', error);
    return { coordinates: null, address: null, dateTime: null };
  }
}



async function reverseGeocode(latitude, longitude) {
  const apiKey = process.env.GEOCODIO_API_KEY;
  const url = `https://api.geocod.io/v1.7/reverse?q=${latitude},${longitude}&api_key=${apiKey}`;

  try {
    const response = await axios.get(url);
    if (response.data && response.data.results && response.data.results.length > 0) {
      const firstResult = response.data.results[0];
      if (firstResult.address_components) {
        return firstResult.address_components;
      } else {
        console.log('Address components not found in the result');
        return null;
      }
    } else {
      console.log('No results found');
      return null;
    }
  } catch (error) {
    console.error('Reverse geocoding failed:', error);
    return null;
  }
}


function createWatermarkString(addressComponents, time) {
  let line1 = '';
  let line2 = '';
  let line3 = '';

  if (addressComponents) {
    // Construct the first line with number, street, and suffix
    line1 = `${addressComponents.number || ''} ${addressComponents.formatted_street || ''}`.trim();

    // Construct the second line with city, state, and zip
    line2 = `${addressComponents.city || ''}, ${addressComponents.state || ''} ${addressComponents.zip || ''}`.trim();
  }

  // Add time to the second line
  if (time) {
    line3 = time;
  }

  let watermarkText = line1 + (line2 ? `\n${line2}` : '') + `\n${line3}`;

  return encodeURIComponent(encodeURIComponent(watermarkText)); // Double-encode for URL compatibility
}



function getCloudinaryUrlWithWatermark(imageUrl, leftLabel, watermarkString) {
  let watermarkParam = `f_auto,c_scale,fl_relative,l_text:Doppio%20One_20_stroke:${watermarkString},g_south_east,y_5,x_10,co_rgb:FFF,bo_5px_solid_black/`;
  watermarkParam += `c_scale,fl_relative,l_text:Doppio%20One_20_stroke:${encodeURIComponent(encodeURIComponent(leftLabel))},g_south_west,y_5,x_10,co_rgb:FFF,bo_5px_solid_black/fl_keep_iptc/`;

  return imageUrl.replace('/upload/', `/upload/${watermarkParam}`);
}

function determineLeftOverlayCondition(exifData, deviceData, callSource) {
  if (callSource === 'EXIF') {
    if (exifData.address && exifData.dateTime) {
      return 'EXIF/EXIF';
    } else if (exifData.address) {
      return 'EXIF/DEVICE';
    } else if (exifData.dateTime) {
      return 'NONE/EXIF';
    } else {
      return 'NONE/DEVICE'; // fallback when called from EXIF, but no data is present
    }
  } else if (callSource === 'DEVICE') {
    if (exifData.address && deviceData.hasTime) {
      return 'EXIF/DEVICE';
    } else if (deviceData.hasGeo && exifData.hasTime) {
      return 'DEVICE/EXIF';
    } else if (deviceData.hasGeo && deviceData.hasTime) {
      return 'DEVICE/DEVICE';
    } else if (exifData.address || exifData.hasTime) {
      return 'NONE/EXIF'; // EXIF data is partially available
    } else {
      return 'NONE/DEVICE'; // No EXIF data and device data is partially available or not available
    }
  } else {
    // Default fallback if callSource is not provided or recognized
    return 'NONE/DEVICE';
  }
}









app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
