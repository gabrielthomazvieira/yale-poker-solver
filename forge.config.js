// forge.config.js
const path = require('path'); // Might be needed for icon path resolving on some systems

module.exports = {
  packagerConfig: {
    asar: true,

    // --- Icon Configuration ---
    // Provide the path to your icon files (without extension)
    // Forge will automatically pick .icns for macOS, .ico for Windows
    icon: path.resolve(__dirname, 'build/icon'), // Use path.resolve for robustness

    // --- Include Directories as Resources ---
    // These directories will be copied into the app's resources folder
    // Accessible via process.resourcesPath in the packaged app
    extraResource: [
      "./install",          // Include the 'install' directory
      "./equity_calculator" // Include the 'equity_calculator' directory
    ],

    // --- Exclude Directories ---
    // Use regex to ignore the 'solver' directory at the root
    // This prevents it from being included in the package/asar archive
    ignore: [
      /^\/solver(\/|$)/, // Matches '/solver' or '/solver/...' at the root
      // Add other patterns here if needed, e.g., to ignore .git, .env files
      /(^|\/)\.git($|\/)/,
      /(^|\/)\.env($|\/)/
    ]
  },
  rebuildConfig: {}, // Add configuration here if you have native Node modules
  makers: [
    // --- Define Output Formats ---
    {
      // Windows Installer (Squirrel)
      name: '@electron-forge/maker-squirrel',
      config: {
        // Options for the Windows installer (e.g., certificate paths for signing)
        // setupIcon: path.resolve(__dirname, 'build/icon.ico') // Explicit setup icon
      },
    },
    {
      // macOS Disk Image
      name: '@electron-forge/maker-dmg',
      config: {
        // background: './build/dmg-background.png', // Optional DMG background
        icon: path.resolve(__dirname, 'build/icon.icns'), // Explicit DMG icon
        format: 'ULFO'
      }
    },
    {
      // Generic Zip (Good fallback for macOS/Linux)
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux'], // Specify platforms for the zip
    },
    {
       // Debian/Ubuntu Package
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          // Maintainer, description, icon etc. for the .deb package
          // icon: path.resolve(__dirname, 'build/icon.png')
        }
      }
    },
    // {
    //   // RedHat/Fedora Package
    //   name: '@electron-forge/maker-rpm',
    //   config: {}
    // }
  ],
  // plugins: [ // Add plugins if needed, e.g., for webpack
  //   {
  //     name: '@electron-forge/plugin-webpack',
  //     config: { /* webpack config */ }
  //   }
  // ]
};