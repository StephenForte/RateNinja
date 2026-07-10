# UserInfo Table Setup

## Overview
To enable company-specific rate filtering, you need to create a UserInfo table in your Airtable base that maps users to their respective company RateView (CompanyID).

## UserInfo Table Structure

### Table Name
- **Table Name**: `UserInfo`
- **Table ID**: `tblUserInfo` (update the AIRTABLE_USER_TABLE_ID in script.js if different)

### Required Fields

| Field Name | Field Type | Description | Example |
|------------|------------|-------------|---------|
| **Username** | Single line text | User's login username | `example-user` |
| **Password** | Single line text | User's login password | Use a unique password; do not add sample credentials to the repository. |
| **RateOwner** | Single line text | CompanyID that matches the CompanyID field in RateEntry table | `COMP001` |

### Sample Records

| Username | Password | RateOwner |
|----------|----------|-----------|
| example-user | Use a unique password | COMP001 |
| AliceS | password123 | COMP002 |
| JohnD | securepass | COMP001 |

## How It Works

1. **User Login**: When a user logs in, the system queries the UserInfo table to authenticate credentials
2. **RateOwner Retrieval**: Upon successful authentication, the system retrieves the user's RateOwner (CompanyID)
3. **Rate Filtering**: The RateEntry table is filtered using the formula: `{CompanyID} = "{RateOwner}"`
4. **Company-Specific Data**: Only rates belonging to the user's company are displayed

## RateEntry Table Requirements

Make sure your existing RateEntry table has a **CompanyID** field:
- **Field Name**: `CompanyID`
- **Field Type**: Single line text
- **Description**: Identifies which company the rate belongs to

## Testing

1. Create the UserInfo table with sample data
2. Ensure RateEntry records have CompanyID values
3. Login with test credentials
4. Verify that only rates matching the user's CompanyID are displayed

## Security Notes

- Consider using more secure authentication methods in production
- Passwords are currently stored in plain text - consider encryption
- RateOwner values should be consistent between UserInfo and RateEntry tables
