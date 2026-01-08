const bcrypt = require('bcrypt');

const hash = '$2b$10$Ophw7M2yY5ITIgk8K/hKbeIN2mYzv/.u2wXQkXXjrlYFhgL8spB2W';
const password = 'REDACTED-ADMIN-KEY';

bcrypt.compare(password, hash, (err, result) => {
  if (err) {
    console.log('Error:', err);
  } else {
    console.log('Password match:', result);
  }
});
