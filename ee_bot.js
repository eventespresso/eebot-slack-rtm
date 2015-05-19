// Requiring modules
var slackBotAPI = require('slackbotapi'),
    slack = require('slack-api'),
    Codebase = require('node-codebase'),
    creds = require('./creds.json'),
    _ = require('lodash'),
    os = require('os'),
    logger = require('jethro'),
    logging = true;

require('shelljs/global');


// Starting slackbot
var slackBot = new slackBotAPI({
	'token': creds.slack.authToken,
	'logging': logging
});


var outputLog = function(obj) {
    if(logging) {
        logger.output(obj);
    }
}


//add method that grabs group name that slackBot doesn't have
getGroup = function( term ) {
    for ( var i in slackBot.data.groups ) {
        if(slackBot.data.groups[i]['name'] === term) var group = slackBot.data.groups[i];
    }
    if(typeof group == 'undefined') {
        for(var i in slackBot.data.groups) {
            if(slackBot.data.groups[i]['id'] === term) var group = slackBot.data.groups[i];
        }
    }
    return group;
}

//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";


//takes an incoming message, parses ticket number(s)
//in it and sends off message to slack channel with ticket
//details. Then touches the related Codebase ticket(s) with the message from
// slack.
var TicketInfoToPost = function( data ) {
    //are there tickets in this?
    var regex = /(#[0-9\-a-z]*)/g,
        tickets = data.text.match(regex),
        ticketQuery = {},
        ticketProject = '',
        ticketProjectRef = '',
        ticketNum = '',
        isChannel = true,
        isGroup = false,
        channelType = data.channel.charAt(0),
        channelProject = '';

    //no tickets? Codebase is the username? get out.
    if ( ! tickets ) {
        return;
    }

    //if channelID does not begin with "C" then it's not a channel
    if ( channelType != 'C' ) {
        isChannel = false;
        isGroup = channelType == 'G' ? true : false;
    }

    tickets.forEach( function(ticket){
        //parse ticket info for setting up messages
        regex = /[#0-9-]/g;
        ticketProjectRef = ticket.replace(regex, '');

        //ensure just ticket num
        regex = /[#a-z-]/g;
        ticketNum = ticket.replace(regex, '');

        if ( ! ticketNum ) {
            return;
        }

        //inferred channel project
        channelProject = typeof creds.codebaseMap.channels[data.channel] !== 'undefined' && isChannel ? creds.codebaseMap.channels[data.channel].projectSlug : creds.codebaseMap.channels.default.projectSlug;
        //if we have a project inferred from ticket use it, otherwise infer
        //from channel.

        ticketProjectRef = ticketProjectRef !== '' && creds.codebaseMap.projects[ticketProjectRef] ? ticketProjectRef : '';
        ticketProjectRef = ticketProjectRef === '' && creds.codebaseMap.channels[data.channel] ? creds.codebaseMap.channels[data.channel].projectRef : ticketProjectRef;
        ticketProjectRef = ticketProjectRef === '' ? creds.codebaseMap.channels.default.projectRef : ticketProjectRef;
        ticketProject = ticketProjectRef !== '' && creds.codebaseMap.projects[ticketProjectRef] ? creds.codebaseMap.projects[ticketProjectRef].projectSlug : channelProject;

        //ticketQuery
        if ( typeof ticketQuery[ticketProject] !== 'undefined' ) {
            ticketQuery[ticketProject].query += ',' + ticketNum;
        } else {
            ticketQuery[ticketProject] = {};
            ticketQuery[ticketProject].project = ticketProject;
            ticketQuery[ticketProject].projectRef = ticketProjectRef;
            ticketQuery[ticketProject].query = 'id:'+ticketNum
        }
    });
    if ( ticketQuery ) {
        //send ticketQuery for retrieving from codebase and posting to slack
        getAndPostTickets(ticketQuery, data, isChannel, isGroup );
    }
};


var getAndPostTickets = function( ticketQuery, data, isChannel, isGroup ) {
    var cb = {},
        codebaseMessage = '',
        channelName = '';

    if ( isChannel ) {
        channelName = slackBot.getChannel(data.channel).name;
    } else if ( isGroup ) {
        channelName = getGroup(data.channel).name;
    } else {
        channelName = data.channel;
    }

    var codeBaseUser = data.username && data.username == 'Codebase';

    //loop through ticketQuery and retrieve, then post info related to each ticket
    cb = new Codebase( creds.codebaseMap.baseEndpoint, creds.codebaseMap.users.eebot.cbAuth.events );
    _.each( ticketQuery, function( queryString, n) {
        cb.tickets.allQuery( queryString.project, { query : queryString.query }, function( cberr, cbdata ) {
            if ( cberr ) {
                console.log( 'Error:' );
                console.log( cbdata );
                return;
            } else {
                //all went well so let's loop through the tickets and grab
                //the details:
                if ( cbdata.tickets ) {
                    cbdata.tickets.ticket.forEach( function( ticket ) {
                        if ( ! ticket.ticketId[0]._ ) {
                            return;
                        }

                        if ( codeBaseUser ) {
                            //get details for first post in ticket
                            cb.tickets.notes.all( queryString.project, ticket.ticketId[0]._, function( cbterr, cbtdata ) {
                               if ( cbterr ) {
                                   console.log('Codebase ticket update error: ');
                                   console.log(cbtdata);
                               } else {
                                   sendSlackTicketNotification( ticket, queryString, channelName, data, cbtdata );
                               }
                            });
                        } else {
                            var cbuser = slackBot.getUser(data.user) ? slackBot.getUser(data.user).name : data.user;
                            if (( isChannel || isGroup ) && ( data.channel != 'C04JV1HFK') && ( data.channel != 'G04J6FDDY') && ( data.channel != '')) {
                                codebaseMessage = cbuser + " [mentioned this ticket][1] in Slack. \n\n> " + data.text + "\n\n[1]: " + creds.slack.archivesEndpoint + channelName + '/p' + data.ts.replace('.', '');
                                cb.tickets.notes.create(queryString.project, {
                                    ticket_id: ticket.ticketId[0]._,
                                    content: codebaseMessage
                                }, function (cbterr, cbtdata) {
                                    if (cbterr) {
                                        console.log('Codebase ticket update error: ');
                                        console.log(cbtdata);
                                    }
                                });
                            }
                            sendSlackTicketNotification( ticket, queryString, channelName, data );
                        }
                    });
                }
            }
        });
    });
}


var sendSlackTicketNotification = function( ticket, queryString, channelName, data, ticketNotes ) {
    var slattachments = [],
        ticketNoteContent = '',
        assignee = '';

    assignee = typeof ticket.assignee[0] === 'object' || typeof ticket.assignee[0] === 'undefined' ? 'unassigned' : ticket.assignee[0];

    //if we have ticketNotes then a BIT different format:
    if ( typeof ticketNotes !== 'undefined' ) {
        ticketNoteContent = ticketNotes.ticketNotes.ticketNote[0].content[0];
        //console.log(ticketNotes.ticketNotes.ticketNote[0].content[0]);
        slattachments.push({
            "fallback" : "More info from the recent ticket creation in codebase has been posted",
            "color" : creds.codebaseMap.colors[ticket.ticketType[0]] ? creds.codebaseMap.colors[ticket.ticketType[0]] : creds.codebaseMap.colors.default,
            "title" : "More details on the ticket just created:",
            "text" : "*Ticket Type:* _" + ticket.ticketType[0] + "_ *Assigned to:* _" + assignee + "_ \n\n" + ticketNoteContent,
            "fields" : [
                {
                    "title" : "Priority",
                    "value" : ticket.priority[0].name[0],
                    "short" : true
                },
                {
                    "title" : "Status",
                    "value" : ticket.status[0].name[0],
                    "short" : true
                },
                {
                    "title" : "Milestone",
                    "value" : ticket.milestone[0].name[0],
                    "short" : false
                }
            ],
            "mrkdwn_in" : ["text","pretext"]
        });
    } else {

        if ( ! ticket.ticketId[0]._ ) {
            return;
        }

        var milestonename = ! ticket.milestone[0].name ? 'unknown or no milestone' : ticket.milestone[0].name[0];

        slattachments.push({
            "fallback": "Ticket " + ticket.ticketId[0]._ + ': ' + ticket.summary[0],
            "color": creds.codebaseMap.colors[ticket.ticketType[0]] ? creds.codebaseMap.colors[ticket.ticketType[0]] : creds.codebaseMap.colors.default,
            "title": "Ticket: " + ticket.ticketId[0]._ + " (" + milestonename + ")",
            "title_link": creds.codebaseMap.projects[queryString.projectRef].url + '/tickets/' + ticket.ticketId[0]._,
            "text": "*Ticket Type:* _" + ticket.ticketType[0] + "_ *Assigned to:* _" + assignee + "_ \n" + ticket.summary[0],
            "fields": [
                {
                    "title": "Priority",
                    "value": ticket.priority[0].name[0],
                    "short": true
                },
                {
                    "title": "Status",
                    "value": ticket.status[0].name[0],
                    "short": true
                }
            ],
            "mrkdwn_in": ["text", "pretext"]
        });
    }

    slattachments = JSON.stringify( slattachments );
    //send message to slack
    slack.chat.postMessage( { token : creds.slack.authToken, text : "", channel : data.channel, attachments : slattachments, as_user : true }, function( slcherr, slchdata ) {
        if ( slcherr ) {
            console.log(slchdata);
        } else {
            outputLog({severity: 'info', source: 'getAndPostTickets', message: 'Sent ticket info to slack', timestamp: new Date(), location: os.hostname() } );
        }
    });
};


var runGrunt = function( data ) {

    var commands = _.keys( creds.grunt.command),
        path = creds.grunt.project.rootpath,
        gruntRun = "grunt ",
        gruntCommand = data.text.split( ' ' );

    //if not a grunt command exit.
    if ( gruntCommand[0].toLowerCase() !== "grunt" ) {
        return;
    }

    //verify that we have a valid command and if so execute.
    if ( ! gruntCommand[1] ) {
        slackBot.sendPM( data.user, "You typed grunt with no command. For a list of commands you can use with `grunt` type `help grunt commands`." );
        return;
    }

    //verify the given command has a configuration setup.
    if ( ! creds.grunt.command[gruntCommand[1]] ) {
        slackBot.sendPM( data.user, "The grunt command you gave: `" + gruntCommand[1] + "` currently is not configured." );
        return;
    }

    //verify there are the right number of params for the command.
    if ( gruntCommand.length !== creds.grunt.command[gruntCommand[1]].params ) {
        slackBot.sendPM( data.user, "I'm expecting " + creds.grunt.command[gruntCommand[1]].params + " parameters but you only gave *" + gruntCommand.length );
        return;
    }

    //verify that the project command exists.
    if ( ! gruntCommand[2] ) {
        slackBot.sendPM( data.user, "You have not given the project to run the grunt command on. For a list of projects that are valid, type `help grunt projects`." );
        return;
    }

    //verify that the given project exists.
    if ( ! creds.grunt.project[gruntCommand[2]] ) {
        slackBot.sendPM( data.user, "The project you gave to run grunt on is not valid." );
        return;
    }

    //NOW we can go ahead and setup to execute grunt!
    path += creds.grunt.project[gruntCommand[2]].slug;
    gruntRun += creds.grunt.command[gruntCommand[1]].params === 4 ? gruntCommand[1] + ':' + gruntCommand[3] : gruntCommand[1];
    cd( path );

    exec( gruntRun );

    //notify user
    slackBot.sendPM( data.user,
        "Okay I've run grunt on *" + creds.grunt.project[gruntCommand[2]].name + "* for you."
    );

}


var ChatWithBot = function ( data ) {
    //match the first word in the chat to get the command
    var command = data.text.split( ' '),
        commands = [];

    switch ( command[0].toLowerCase() ) {
        case "hello" :
            slackBot.sendPM( data.user, "Oh, hello @" + slackBot.getUser(data.user).name+" !" );
            break;

        case "help" :
            //if help is alone, then let's send a list of commands they can learn more about.
            if ( typeof command[1] === 'undefined' ) {
                var helpcommands = [
                    "*I'm here to serve!* Here's some commands I know that I can give more information on, just type `help` followed by the item in the list below.",
                    "• `tickets` - _more info on how ticket stuff works_",
                    "• `grunt` - _more info on the grunt commands I can do_"
                ]
                slackBot.sendPM( data.user, helpcommands.join("\n") );
            } else {
                switch ( command[1].toLowerCase() ) {

                    case "ticket":
                    case "tickets":
                        commands = [
                            "*Here's some info on the eebot ticket service*",
                            "• Type `#123` where the number is the ticket you want to show",
                            "• The default project tickets are pulled from is the `event-espresso` project. (Type `#123-eecore` anywhere to explicitly get tickets from that project)",
                            "• Ticket numbers typed in the #eventsmart channel are from the `saas` project (Type `#123-eesaas` anywhere else to explicitly get tickets from the saas project)",
                            "• Ticket numbers typed in the #infrastructure channel are from the `website` project (Type `#123-web` anywhere to explicitly get tickets from that project)",
                            "• You can grab multiple tickets at once by having multiple ticket numbers in your chat message."
                        ];
                        slackBot.sendPM( data.user, commands.join("\n") );
                        break;
                    case "grunt" :
                        if ( command[2] ) {
                            if ( command[2].toLowerCase() == 'commands' ) {
                                commands = [
                                    "Here's the different commands you can use with `grunt`:"
                                ];

                                _.keys( creds.grunt.command).forEach( function(gc)  {
                                    commands.push( "• *" + gc + "*: " + creds.grunt.command[gc].description );
                                });

                            } else if ( command[2].toLowerCase() == 'projects' ) {
                                commands = [
                                    "Here's the different project references you can use with `grunt`:"
                                ];
                                _.keys( creds.grunt.project).forEach( function(gp) {
                                    if ( gp == 'rootpath' ) return;
                                    commands.push( "• *" + gp + "*: _" + creds.grunt.project[gp].name + "_" );
                                });
                            } else {
                                commands = [
                                    "hmm... I dont' recognize that help text. Try again? Type `help grunt`."
                                ]
                            }
                            slackBot.sendPM( data.user, commands.join("\n") );
                            return;
                            break;
                        }
                        commands = [
                            "I can speak to my pal grunt to run tasks on your projects that we know about. The usual format for grunt commands is:",
                            "*_grunt {command} {project} [other-options]_*\n",
                            "For more info on the commands, type `help grunt commands`",
                            "For more info on the projects, type `help grunt projects`"
                        ];
                        slackBot.sendPM( data.user, commands.join("\n") );
                        break;
                }
            }
            break;

    }
}

// Slack on EVENT message, send data.
slackBot.on('message', function(data) {

	// If no text, return.
	if(typeof data.text === 'undefined') return;

	// If someone says 'cake!!' respond to their message with "@user OOH, CAKE!! :cake"
	if(data.text === 'cake!!') slackBot.sendMsg(data.channel, "@"+slackBot.getUser(data.user).name+" OOH, CAKE!! :cake:");

    //split


    // if the "#[0-9]" is found anywhere in the message look up the ticket.
    TicketInfoToPost( data );

    //possible chatting with bot?
    ChatWithBot( data );

    //possible Grunt command?
    runGrunt( data );

	// If the first character starts with /, you can change this to your own prefix of course.
	if(data.text.charAt(0) === '%') {
		// Split the command and it's arguments into an array
		var command = data.text.substring(1).split(' ');

		// If command[2] is not undefined use command[1] to have all arguments in comand[1]
		if (typeof command[2] != "undefined") {
			for (var i = 2; i < command.length; i++) {
				command[1] = command[1] + ' ' + command[i];
			}
		}

		// Switch to check which command has been requested.
		switch (command[0].toLowerCase()) {

			case "say":
				var say = data.text.split('%say ');
				slackBot.sendMsg(data.channel, say[1]);
			break;


            //testing codebase
            case "cbtest":
                var cb = new Codebase( creds.codebaseMap.baseEndpoint, creds.codebaseMap.users.darren.cbAuth.events );
                console.log('got the message');
                cb.tickets.allQuery( 'event-espresso', { query : 'id:1000,1001' }, function( err, cbdata ) {
                    console.log('begin');
                   if ( err ) {
                       console.log('Error:');
                       console.log( cbdata );
                       return;
                   }
                    console.log( cbdata.tickets.ticket[0].status );
                    console.log( cbdata.tickets.ticket[0].priority );
                    console.log( cbdata.tickets.ticket[0].ticketId);
                    console.log( cbdata.tickets.ticket[0].milestone );
                    console.log( cbdata.tickets.ticket );
                    console.log(cbdata);
                });
                break;

			case "debug":
				console.log(slackBot.data.ims);
			break;
		}
	}
});
