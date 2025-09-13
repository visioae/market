const express = require('express');
const app = express();

// Skapar en enkel hemsida
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Startar servern på den port Replit använder
const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running on port ' + listener.address().port);
});
