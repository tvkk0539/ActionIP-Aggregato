const app = require('./src/app');
const config = require('./src/config');

app.listen(config.PORT, () => {
  console.log(`ActionIP Aggregator listening on port ${config.PORT}`);
});
