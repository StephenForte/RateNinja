# 🌊 Ocean Freight Rates API Documentation

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/StephenForte/RateNinja)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Airtable](https://img.shields.io/badge/powered%20by-Airtable-orange.svg)](https://airtable.com)

> **Interactive API documentation for the Ocean Freight Rates application**

## 📋 Table of Contents

- [Overview](#overview)
- [Interactive Documentation](#interactive-documentation)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
- [Data Models](#data-models)
- [Rate Calculation Logic](#rate-calculation-logic)
- [Usage Examples](#usage-examples)
- [Error Handling](#error-handling)

---

## 🎯 Overview

The Ocean Freight Rates API is built on Airtable and provides:

- **User Authentication**: Secure login with role-based access control
- **Rate Management**: View and filter ocean freight shipping rates
- **Company Management**: Admin capabilities for margin settings
- **Sailing Schedules**: Real-time vessel departure and arrival information

### Base URL
```
https://api.airtable.com/v0/appBLegnJMAienppq
```

### Key Features

✅ **RateView-based filtering** - Users only see rates they have access to  
✅ **Margin calculations** - Automatic price adjustments based on company settings  
✅ **Admin controls** - Manage margin settings for multiple companies  
✅ **Real-time data** - All data synced with Airtable in real-time  

---

## 🌐 Interactive Documentation

**View the full interactive API documentation:**

👉 **Open `api-docs.html` in your browser** or visit:
```bash
# Start local server
python3 -m http.server 8000

# Then open in browser:
http://localhost:8000/api-docs.html
```

The interactive docs provide:
- 🧪 **Try it out** - Test API calls directly from the browser
- 📖 **Complete schemas** - All request/response models documented
- 🔍 **Search functionality** - Quickly find endpoints
- 💡 **Example data** - Real-world examples for every endpoint

---

## 🔐 Authentication

All API requests require authentication using an Airtable Personal Access Token (PAT).

### Authorization Header
```http
Authorization: Bearer patmavgfaBmeaZt0V.31aae1face1c9ecbebb893a46eb6672104ea7aa700164c2cc7e7a952a088045f
```

### User Login Flow

1. **GET** `/UserInfo` with filter by username and password
2. Extract user's `RateView`, `CompanyID`, and `AdminScreen` status
3. Store user session in localStorage
4. All subsequent requests filter data based on user's `RateView`

**Example Request:**
```javascript
const response = await fetch(
  'https://api.airtable.com/v0/appBLegnJMAienppq/UserInfo?filterByFormula=AND({UserName}="BobJ",{Pwd}="aabbccdd")',
  {
    headers: {
      'Authorization': 'Bearer YOUR_API_TOKEN'
    }
  }
);
```

---

## 📡 API Endpoints

### Authentication

#### Get User Information
```http
GET /UserInfo?filterByFormula=AND({UserName}='USERNAME',{Pwd}='PASSWORD')
```

**Response Fields:**
- `UserID` - Unique user identifier
- `UserName` - Login username
- `DisplayName` - User's full name
- `CompanyID` - User's company ID (from CompanyReference)
- `RateView` - Determines which rates user can access (integer)
- `AdminScreen` - Boolean flag for admin access

---

### Rate Entry

#### Get Shipping Rates
```http
GET /Rate Entry?filterByFormula={RateOwner}=1
```

**Query Parameters:**
- `filterByFormula` - Airtable formula (automatically set based on user's RateView)
- `offset` - Pagination token for next page

**Response Fields:**
- `Carrier` - Shipping line (e.g., MSC, Maersk, CMA CGM)
- `ContractOwner` - Company that owns the contract
- `OriginPort` / `OriginCountry` - Departure location
- `DestinationPort` / `DestinationCountry` - Arrival location
- `ServiceType` - Direct, Transshipment, etc.
- `Rate20D` - Rate for 20' Dry container
- `Rate40D` - Rate for 40' Dry container
- `Rate40HC` - Rate for 40' High Cube container
- `RateEffectiveDate` / `RateExpirationDate` - Validity period
- `InlandDeliveryLocation` - Final delivery destination
- `CommodityType` - Type of goods
- `TransitTime` - Days from departure to arrival

---

### Company Reference

#### Get Company Data
```http
GET /CompanyReference
```

**Response Fields:**
- `CompanyID` - Unique company identifier
- `CompanyName` - Company display name
- `CompanyType` - 1=Admin, 2=Regular
- `RateView` - Rate view group
- `Admin` - If true, no margin calculations
- `MarginPercent` - Percentage markup (0.25 = 25%)
- `MarginNumber` - Fixed dollar amount to add

#### Update Company Margins (Admin Only)
```http
PATCH /CompanyReference/{recordId}
```

**Request Body:**
```json
{
  "fields": {
    "MarginPercent": 0.30,
    "MarginNumber": 150.00
  }
}
```

---

### Sailings

#### Get Vessel Schedules
```http
GET /Sailings?filterByFormula=AND({Carrier}='MSC',{DeparturePort}='Shanghai',{Departure}>'2025-01-01')
```

**Response Fields:**
- `Carrier` - Shipping line
- `VesselName` - Name of vessel
- `VoyageNumber` - Voyage identifier
- `DeparturePort` / `ArrivalPort` - Route
- `Departure` / `Arrival` - Date/times
- `TransitTime` - Duration in days

---

## 📊 Data Models

### Rate Filtering Logic

```
User logs in → Extract RateView value
                    ↓
Rate Entry filtered by: RateEntry.RateOwner = UserInfo.RateView
                    ↓
User sees only accessible rates
```

### Company Hierarchy

```
CompanyType:
  1 = Admin Company (no margins applied)
  2 = Regular Company (margins applied)

RateView Groups:
  Users and companies grouped by RateView number
  All users with RateView=1 see the same rate pool
```

---

## 💰 Rate Calculation Logic

### Final Rate Formula

```javascript
if (CompanyReference.Admin === true) {
  finalRate = baseRate; // No markup
} else {
  finalRate = (baseRate × (1 + MarginPercent)) + MarginNumber;
}
```

### Example Calculation

**Scenario:**
- Base Rate (20D): $1,500
- MarginPercent: 0.25 (25%)
- MarginNumber: $100

**Calculation:**
```javascript
finalRate = ($1,500 × (1 + 0.25)) + $100
finalRate = ($1,500 × 1.25) + $100
finalRate = $1,875 + $100
finalRate = $1,975
```

**Applied to all container types:**
- 20D: $1,975
- 40D: $2,600 (if base is $2,000)
- 40HC: $2,725 (if base is $2,100)

---

## 🔧 Usage Examples

### JavaScript/Fetch

```javascript
// Authenticate user
async function loginUser(username, password) {
  const formula = `AND({UserName}='${username}',{Pwd}='${password}')`;
  const url = `https://api.airtable.com/v0/appBLegnJMAienppq/UserInfo?filterByFormula=${encodeURIComponent(formula)}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': 'Bearer YOUR_API_TOKEN'
    }
  });
  
  const data = await response.json();
  if (data.records.length > 0) {
    const user = data.records[0].fields;
    return {
      displayName: user.DisplayName,
      rateView: user.RateView,
      companyID: user['CompanyID (from CompanyReference)'][0],
      isAdmin: user.AdminScreen === true
    };
  }
  throw new Error('Invalid credentials');
}

// Get rates for user
async function getRates(userRateView) {
  const formula = `{RateOwner}=${userRateView}`;
  const url = `https://api.airtable.com/v0/appBLegnJMAienppq/Rate Entry?filterByFormula=${encodeURIComponent(formula)}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': 'Bearer YOUR_API_TOKEN'
    }
  });
  
  const data = await response.json();
  return data.records;
}

// Calculate final rate with margin
function calculateFinalRate(baseRate, marginPercent, marginNumber, isAdmin) {
  if (isAdmin) return baseRate;
  
  // Convert percentage if needed (25 → 0.25)
  const percent = marginPercent > 1 ? marginPercent / 100 : marginPercent;
  
  return (baseRate * (1 + percent)) + marginNumber;
}
```

### cURL Examples

```bash
# Login user
curl "https://api.airtable.com/v0/appBLegnJMAienppq/UserInfo?filterByFormula=AND({UserName}='BobJ',{Pwd}='aabbccdd')" \
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Get rates
curl "https://api.airtable.com/v0/appBLegnJMAienppq/Rate%20Entry?filterByFormula={RateOwner}=1" \
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Update company margin (Admin only)
curl -X PATCH "https://api.airtable.com/v0/appBLegnJMAienppq/CompanyReference/recKB5pgQ9MfFN5Pi" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "MarginPercent": 0.30,
      "MarginNumber": 150.00
    }
  }'

# Get sailings
curl "https://api.airtable.com/v0/appBLegnJMAienppq/Sailings?filterByFormula=AND({Carrier}='MSC',{DeparturePort}='Shanghai')" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

## ⚠️ Error Handling

### Common HTTP Status Codes

| Code | Meaning | Common Cause |
|------|---------|--------------|
| `200` | Success | Request completed successfully |
| `400` | Bad Request | Invalid request body or parameters |
| `401` | Unauthorized | Missing or invalid API token |
| `403` | Forbidden | Insufficient permissions |
| `404` | Not Found | Record or endpoint doesn't exist |
| `422` | Unprocessable | Invalid filterByFormula syntax |

### Error Response Format

```json
{
  "error": {
    "type": "INVALID_REQUEST_UNKNOWN",
    "message": "Invalid formula"
  }
}
```

### Best Practices

1. **Always validate** user input before constructing filterByFormula
2. **Escape special characters** in formulas (quotes, parentheses)
3. **Handle pagination** - Check for `offset` in response
4. **Cache CompanyReference data** - Fetch once per session
5. **Implement retry logic** - For network failures

---

## 🚀 Quick Start

### 1. Clone the Repository
```bash
git clone https://github.com/StephenForte/RateNinja.git
cd RateNinja
```

### 2. Start the Server
```bash
python3 -m http.server 8000
```

### 3. View Documentation
```
Open: http://localhost:8000/api-docs.html
```

### 4. Test Login
```
Username: BobJ
Password: aabbccdd
```

---

## 📝 Notes

### Airtable Specifics

- **Record IDs** start with `rec` (e.g., `recKB5pgQ9MfFN5Pi`)
- **Linked records** are arrays of record IDs
- **Formula syntax** uses Airtable formula language
- **Pagination** required for tables with >100 records

### Security Considerations

- ⚠️ **Never expose** API tokens in client-side code (production)
- 🔒 **Use environment variables** for sensitive data
- 🛡️ **Validate all user input** before database queries
- 🔐 **Implement proper CORS** policies for production

---

## 🤝 Contributing

Contributions welcome! Please feel free to submit a Pull Request.

---

## 📧 Contact

**Stephen Forte**  
GitHub: [@StephenForte](https://github.com/StephenForte)  
Project: [RateNinja](https://github.com/StephenForte/RateNinja)

---

## 📄 License

This project is licensed under the MIT License.

---

<div align="center">

**Built with ❤️ using Airtable**

[View Interactive Docs](./api-docs.html) | [GitHub Repository](https://github.com/StephenForte/RateNinja)

</div>

