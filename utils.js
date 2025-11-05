import { readFileSync } from 'fs'

const config = JSON.parse(readFileSync('config.json'))

export function formatDate (date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/**
 * @param {String} message
 * @param {Number} length
 */
export function truncate (message, length = config.truncate_length) {
  if (message.length > length) {
    return `${message.slice(0, length - 3)}...`
  }
  return message
}
