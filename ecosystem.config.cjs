module.exports = {
  apps: [
    {
      name: "frp-controller",
      interpreter: "/bin/env",
      interpreter_args: "-S bun",
      script: "src/index.ts",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        TZ: 'Asia/Shanghai',
        NODE_ENV: "production",
      },
    },
  ],
};