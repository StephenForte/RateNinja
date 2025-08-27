# Vortecx Rate Engine

A modern web application for querying ocean freight shipping container rates from Airtable.

## Features

- **Real-time Data**: Fetches shipping rates directly from Airtable
- **Advanced Search**: Search across all fields including carriers, ports, and contract owners
- **Smart Filtering**: Filter by Carrier, Origin Port, Destination Port, and Contract Owner
- **Sortable Columns**: Click any column header to sort data
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Modern UI**: Clean, professional interface with smooth animations

## Data Fields

The application displays all columns from your Airtable RateEntry table:

- **Rate Type**: Type of shipping rate (e.g., "Port to Port")
- **Origin Port**: Starting port (e.g., "Surabaya")
- **Destination Port/Via Port**: Destination ports (e.g., "Tacoma, WA")
- **Carrier**: Shipping company (e.g., "HMM")
- **Contract Owner**: Contract holder (e.g., "JGL Supreme")
- **20D Rate (USD)**: 20-foot container rate
- **40D Rate (USD)**: 40-foot container rate
- **40HC Rate (USD)**: 40-foot high cube container rate
- **Rate Effective Date**: When the rate becomes valid (MM/DD/YY format)
- **Rate Expiration Date**: When the rate expires (MM/DD/YY format)
- **Notes 1**: Additional information

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/StephenForte/RateNinja.git
   cd RateNinja
   ```

2. Open `index.html` in your web browser, or serve it using a local web server:
   ```bash
   python3 -m http.server 8000
   ```

3. Access the application at `http://localhost:8000`

## Configuration

The application is configured to connect to your Airtable:
- **Base ID**: `appBLegnJMAienppq`
- **Table ID**: `tbl5OpIdW2kyRRWLp`
- **API Key**: Configured in `script.js`

## Usage

1. **Search**: Use the search box to find specific rates, carriers, or routes
2. **Filter**: Use the dropdown menus to filter by carrier, origin port, destination port, or contract owner
3. **Sort**: Click column headers to sort the data
4. **Navigate**: Use pagination controls to browse through multiple pages
5. **View Details**: Click the "View" button to see complete rate information

## Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **API**: Airtable REST API
- **Styling**: Modern CSS with Flexbox/Grid layouts
- **Icons**: Font Awesome
- **Fonts**: Inter font family

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## License

This project is proprietary software for Vortecx.
