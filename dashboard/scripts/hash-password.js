import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const inlinePassword = process.argv.slice(2).join(" ");

if (inlinePassword) {
  console.log(await bcrypt.hash(inlinePassword, 12));
  process.exit(0);
}

const rl = createInterface({ input, output });
const password = await rl.question("Dashboard password: ");
rl.close();

if (!password) {
  console.error("Password cannot be empty.");
  process.exit(1);
}

console.log(await bcrypt.hash(password, 12));
