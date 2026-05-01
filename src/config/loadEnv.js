const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

let loaded = false;

function loadEnv() {
  if (loaded) {
    return;
  }

  const rootDir = path.resolve(__dirname, "..", "..");
  const envFiles = [".env.local", ".env"];

  for (const fileName of envFiles) {
    const filePath = path.join(rootDir, fileName);

    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath });
    }
  }

  loaded = true;
}

module.exports = {
  loadEnv,
};
