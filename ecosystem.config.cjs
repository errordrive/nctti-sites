// PM2 process file for NCTTI Sites on the VPS.
// Usage: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "nctti-sites",
      script: "server.js",
      env: {
        PORT: 3000,
      },
      // .env file in the app dir provides the rest (see .env.example)
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
